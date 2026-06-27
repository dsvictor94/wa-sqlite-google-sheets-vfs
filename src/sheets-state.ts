import * as SQLite from "wa-sqlite/src/sqlite-constants.js";
import {
  CONTROL_SHEET_ID,
  CONTROL_SHEET_NAME,
  DATA_SHEET_NAME,
  DEFAULT_LEASE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_CELL_PREFIX,
  LOCK_STATE_CELL,
  LOCK_STATE_COLUMN_INDEX,
  LOCK_STATE_ROW_INDEX,
} from "./constants.js";
import { formatControlState, GoogleSdkSheetsClient, type SpreadsheetBatchUpdateResult, type SpreadsheetRequest } from "./google-sheets-client.js";
import { quoteSheetName, sleep } from "./util.js";

export type GoogleSheetsLeaseOptions = { databaseId: string; blockSheetName?: string; lockSheetName?: string; leaseMs?: number; lockTimeoutMs?: number; lockReleaseDelayMs?: number };
export type GoogleSheetsWriteBatchRenewal = { requests: SpreadsheetRequest[]; replyIndex: number; expiresAtSec: string; dataSheetId: number };

export type GoogleSheetsWriteBatchRenewalResult = "renewed" | "stale-but-written";
type LockLetter = "S" | "R" | "P" | "X";
type ControlEntry = {
  letter: LockLetter | "B";
  expiresAtSec: string;
  owner: string;
};
type ControlState = {
  dataSheetId: number;
  entries: ControlEntry[];
};
type RecoveryCandidate = {
  oldDataSheetId: number;
};

type CellData = { userEnteredValue: { stringValue?: string; numberValue?: number; boolValue?: boolean } };

const BASE_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 250;
const EXP = "[0-9]{10}";
const OWNER = "[^;]+";
const NORMAL_ENTRY = `[SRPX]:${EXP}:${OWNER};`;
const BARRIER_ENTRY = `B:${EXP}:${OWNER};`;
const ANY_ENTRY = `(?:${NORMAL_ENTRY}|${BARRIER_ENTRY})`;
const SQLITE_LOCK_NONE = SQLite.SQLITE_LOCK_NONE;
const SQLITE_LOCK_SHARED = SQLite.SQLITE_LOCK_SHARED;
const SQLITE_LOCK_RESERVED = SQLite.SQLITE_LOCK_RESERVED;
const SQLITE_LOCK_PENDING = SQLite.SQLITE_LOCK_PENDING;
const SQLITE_LOCK_EXCLUSIVE = SQLite.SQLITE_LOCK_EXCLUSIVE;

export class GoogleSheetsLease {
  private readonly ownerKey = randomOwnerKey();
  private readonly leaseMs: number;
  private readonly lockTimeoutMs: number;
  private readonly renewBeforeExpiryMs: number;
  private localLock = SQLITE_LOCK_NONE;
  private expiresAtSec: string | null = null;
  private activeDataSheetId: number | null = null;

  constructor(private readonly client: GoogleSdkSheetsClient, options: GoogleSheetsLeaseOptions) {
    void options.databaseId;
    void options.blockSheetName;
    void options.lockSheetName;
    void options.lockReleaseDelayMs;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.renewBeforeExpiryMs = Math.min(5_000, Math.max(1_000, Math.floor(this.leaseMs / 3)));
  }

  get isHeld(): boolean { return this.localLock !== SQLITE_LOCK_NONE && this.hasUsableLocalLease(); }
  get hasReservedLock(): boolean { return this.localLock >= SQLITE_LOCK_RESERVED && this.hasUsableLocalLease(); }
  get ownerToken(): string { return this.ownerKey; }
  get controlRange(): string { return `${quoteSheetName(CONTROL_SHEET_NAME)}!${LOCK_STATE_CELL}`; }
  get dataSheetId(): number {
    if (this.activeDataSheetId === null) throw new Error("Google Sheets VFS active Data sheet id is unknown; acquire a lock first");
    return this.activeDataSheetId;
  }

  async acquire(targetLock = SQLITE_LOCK_EXCLUSIVE): Promise<boolean> {
    const target = normalizeLock(targetLock);
    if (this.localLock >= target && this.hasUsableLocalLease()) return await this.renewCurrentLockIfNeeded();
    this.dropExpiredLocalLock();

    const deadline = Date.now() + this.lockTimeoutMs;
    let attempt = 0;
    do {
      const expiresAtSec = this.nextExpiresAtSec();
      const recoveryCutoffSec = fixedWidthUnixSec(Date.now());
      const requests: SpreadsheetRequest[] = [this.cleanupExpiredNonExclusiveRequest()];
      const recoveryStartIndex = requests.length;
      requests.push(this.expiredRecoveryBarrierRequest(recoveryCutoffSec, expiresAtSec));
      const normalStartIndex = requests.length;
      requests.push(...this.acquireRequests(target, expiresAtSec));

      const response = await this.client.spreadsheetBatchUpdate(requests, {
        includeSpreadsheetInResponse: true,
        responseRanges: [this.controlRange],
        responseIncludeGridData: true,
      });
      const state = this.controlStateFromBatchUpdate(response);
      this.activeDataSheetId = state.dataSheetId;

      if (changed(response, recoveryStartIndex)) {
        const recovery = this.recoveryCandidateFromBarrierState(state);
        if (recovery !== null && await this.completeRecoveryAcquire(target, recovery)) return true;
      } else if (this.applyAcquireResponse(target, expiresAtSec, normalStartIndex, response, state)) {
        return true;
      }

      await sleep(retryDelay(attempt++));
    } while (Date.now() < deadline);
    return false;
  }

  async release(targetLock = SQLITE_LOCK_NONE): Promise<void> {
    const target = normalizeUnlockTarget(targetLock);
    if (this.localLock <= target) return;

    const requests: SpreadsheetRequest[] = [];
    let downgradeReplyIndex: number | null = null;

    if (target === SQLITE_LOCK_NONE) {
      requests.push(this.regexFindReplaceRequest(`[SRPX]:${EXP}:${escapeRegex(this.ownerKey)};`, "", false));
    } else {
      const current = this.currentEntry();
      if (current === null) {
        this.clearLocalState();
        throw new Error("Google Sheets VFS cannot downgrade a missing local lock entry");
      }

      downgradeReplyIndex = requests.length;
      requests.push(this.exactFindReplaceRequest(this.entry(current.letter, current.expiresAtSec), this.entry("S", current.expiresAtSec), false));
    }

    requests.push(this.cleanupExpiredNonExclusiveRequest());
    const response = await this.client.spreadsheetBatchUpdate(requests);

    if (target === SQLITE_LOCK_NONE) {
      this.clearLocalState();
      return;
    }

    if (downgradeReplyIndex === null || !changed(response, downgradeReplyIndex)) {
      this.clearLocalState();
      throw new Error("Google Sheets VFS lock downgrade failed; local lease no longer matches durable state");
    }

    this.localLock = SQLITE_LOCK_SHARED;
  }

  async checkReservedLock(): Promise<boolean> {
    if (this.hasReservedLock) return true;
    const response = await this.client.spreadsheetBatchUpdate([
      this.cleanupExpiredNonExclusiveRequest(),
      this.regexFindReplaceRequest(`^(${this.anyStatePrefix()}(?:${ANY_ENTRY})*(?:[RPX]:${EXP}:${OWNER};|B:${EXP}:${OWNER};)(?:${ANY_ENTRY})*)$`, "$1!", true),
      this.regexFindReplaceRequest("!", "", false),
    ]);
    return changed(response, 1);
  }

  async createWriteBatchRenewal(): Promise<GoogleSheetsWriteBatchRenewal | null> {
    if (!(await this.acquire(SQLITE_LOCK_EXCLUSIVE))) return null;
    const current = this.currentEntry();
    if (current === null || current.letter !== "X") return null;
    const dataSheetId = this.dataSheetId;
    const expiresAtSec = this.nextExpiresAtSec();
    return {
      requests: [this.regexFindReplaceRequest(`^${this.statePrefix(dataSheetId)}${this.entry("X", current.expiresAtSec)}$`, `${formatControlState(dataSheetId, this.entry("X", expiresAtSec))}`, true)],
      replyIndex: 0,
      expiresAtSec,
      dataSheetId,
    };
  }

  completeWriteBatchRenewal(response: SpreadsheetBatchUpdateResult, renewal: GoogleSheetsWriteBatchRenewal): GoogleSheetsWriteBatchRenewalResult {
    if (!changed(response, renewal.replyIndex)) {
      this.clearLocalState();
      return "stale-but-written";
    }
    this.localLock = SQLITE_LOCK_EXCLUSIVE;
    this.expiresAtSec = renewal.expiresAtSec;
    this.activeDataSheetId = renewal.dataSheetId;
    return "renewed";
  }

  applyOwnerCheck(controlValue: unknown): boolean {
    if (!this.isHeld) {
      this.clearLocalState();
      return false;
    }

    const state = parseControlState(controlValue);
    if (state === null || !state.entries.some((entry) => entry.owner === this.ownerKey)) {
      this.clearLocalState();
      return false;
    }

    this.activeDataSheetId = state.dataSheetId;
    return true;
  }

  clearLocalState(): void {
    this.localLock = SQLITE_LOCK_NONE;
    this.expiresAtSec = null;
    this.activeDataSheetId = null;
  }

  private async renewCurrentLockIfNeeded(): Promise<boolean> {
    if (!this.shouldRenewLocalLease()) return true;
    const current = this.currentEntry();
    if (current === null || !this.hasUsableLocalLease()) return false;
    const expiresAtSec = this.nextExpiresAtSec();
    const response = await this.client.spreadsheetBatchUpdate([
      this.cleanupExpiredNonExclusiveRequest(),
      this.exactFindReplaceRequest(this.entry(current.letter, current.expiresAtSec), this.entry(current.letter, expiresAtSec), false),
    ]);
    if (!changed(response, 1)) {
      this.clearLocalState();
      return false;
    }
    this.expiresAtSec = expiresAtSec;
    return true;
  }

  private acquireRequests(target: number, expiresAtSec: string): SpreadsheetRequest[] {
    const otherOwner = `(?!${escapeRegex(this.ownerKey)};)${OWNER}`;
    const otherS = `S:${EXP}:${otherOwner};`;
    const otherSR = `(?:S|R):${EXP}:${otherOwner};`;
    const prefix = `(${this.anyStatePrefix()})`;
    if (target === SQLITE_LOCK_SHARED) return [this.regexFindReplaceRequest(`^${prefix}((?:${otherSR})*)(?:S:${EXP}:${escapeRegex(this.ownerKey)};)?((?:${otherSR})*)$`, `$1$2${this.entry("S", expiresAtSec)}$3`, true)];
    if (target === SQLITE_LOCK_RESERVED) return [this.regexFindReplaceRequest(`^${prefix}((?:${otherS})*)(?:(?:S|R):${EXP}:${escapeRegex(this.ownerKey)};)?((?:${otherS})*)$`, `$1$2${this.entry("R", expiresAtSec)}$3`, true)];
    if (target === SQLITE_LOCK_PENDING) return [this.regexFindReplaceRequest(`^${prefix}((?:${otherS})*)(?:(?:S|R|P):${EXP}:${escapeRegex(this.ownerKey)};)?((?:${otherS})*)$`, `$1$2${this.entry("P", expiresAtSec)}$3`, true)];
    return [
      this.regexFindReplaceRequest(`^${prefix}((?:${otherS})*)(?:(?:S|R|P):${EXP}:${escapeRegex(this.ownerKey)};)?((?:${otherS})*)$`, `$1$2${this.entry("P", expiresAtSec)}$3`, true),
      this.regexFindReplaceRequest(`^(${this.anyStatePrefix()})P:${expiresAtSec}:${escapeRegex(this.ownerKey)};$`, `$1${this.entry("X", expiresAtSec)}`, true),
    ];
  }

  private applyAcquireResponse(target: number, expiresAtSec: string, normalStartIndex: number, response: SpreadsheetBatchUpdateResult, state: ControlState): boolean {
    if (target === SQLITE_LOCK_EXCLUSIVE) {
      if (changed(response, normalStartIndex + 1)) {
        this.localLock = SQLITE_LOCK_EXCLUSIVE;
        this.expiresAtSec = expiresAtSec;
        this.activeDataSheetId = state.dataSheetId;
        return true;
      }
      if (changed(response, normalStartIndex)) {
        this.localLock = SQLITE_LOCK_PENDING;
        this.expiresAtSec = expiresAtSec;
        this.activeDataSheetId = state.dataSheetId;
      }
      return false;
    }
    if (!changed(response, normalStartIndex)) return false;
    this.localLock = target;
    this.expiresAtSec = expiresAtSec;
    this.activeDataSheetId = state.dataSheetId;
    return true;
  }

  private recoveryCandidateFromBarrierState(state: ControlState): RecoveryCandidate | null {
    if (state.entries.length !== 1) return null;
    const [entry] = state.entries;
    if (entry.letter !== "B" || entry.owner !== this.ownerKey) return null;
    return { oldDataSheetId: state.dataSheetId };
  }

  private expiredRecoveryBarrierRequest(cutoffSec: string, barrierExpiresAtSec: string): SpreadsheetRequest {
    const expired = fixedWidthDecimalLeRegex(cutoffSec);
    return this.regexFindReplaceRequest(
      `^(${this.anyStatePrefix()})(?:X|B):${expired}:${OWNER};$`,
      `$1B:${barrierExpiresAtSec}:${this.ownerKey};`,
      true,
    );
  }

  private async completeRecoveryAcquire(target: number, recovery: RecoveryCandidate): Promise<boolean> {
    const targetLetter = lockLetter(target);
    if (targetLetter === null) throw new Error(`Invalid SQLite recovery target ${target}`);

    const oldDataSheetId = recovery.oldDataSheetId;
    const newDataSheetId = oldDataSheetId + 1;
    const expiresAtSec = this.nextExpiresAtSec();
    const tempSheetName = `__sqlite_recovery_${newDataSheetId}`;

    try {
      await this.client.spreadsheetBatchUpdate([
        { duplicateSheet: { sourceSheetId: oldDataSheetId, insertSheetIndex: 1, newSheetId: newDataSheetId, newSheetName: tempSheetName } },
        { deleteSheet: { sheetId: oldDataSheetId } },
        { updateSheetProperties: { properties: { sheetId: newDataSheetId, title: DATA_SHEET_NAME }, fields: "title" } },
        this.updateControlCellRequest(formatControlState(newDataSheetId, this.entry(targetLetter, expiresAtSec))),
      ]);
    } catch {
      this.clearLocalState();
      this.client.clearSheetIdCache(DATA_SHEET_NAME);
      return false;
    }

    this.client.clearSheetIdCache(DATA_SHEET_NAME);
    this.client.rememberSheetId(DATA_SHEET_NAME, newDataSheetId);
    this.activeDataSheetId = newDataSheetId;
    this.localLock = target;
    this.expiresAtSec = expiresAtSec;
    return true;
  }

  private controlStateFromBatchUpdate(response: SpreadsheetBatchUpdateResult): ControlState {
    const state = parseControlState(controlValueFromBatchUpdate(response));
    if (state === null) throw new Error("Invalid Google Sheets VFS control state returned by lock batch update");
    return state;
  }

  private cleanupExpiredNonExclusiveRequest(): SpreadsheetRequest {
    const cutoffSec = fixedWidthUnixSec(Date.now());
    return this.regexFindReplaceRequest(`[SRP]:(?:${fixedWidthDecimalLeRegex(cutoffSec)}):${OWNER};`, "", false);
  }

  private regexFindReplaceRequest(find: string, replacement: string, matchEntireCell: boolean): SpreadsheetRequest {
    return { findReplace: { find, replacement, matchCase: true, matchEntireCell, searchByRegex: true, includeFormulas: false, range: this.lockCellRange() } };
  }

  private exactFindReplaceRequest(find: string, replacement: string, matchEntireCell: boolean): SpreadsheetRequest {
    return { findReplace: { find, replacement, matchCase: true, matchEntireCell, searchByRegex: false, includeFormulas: false, range: this.lockCellRange() } };
  }

  private updateControlCellRequest(value: string): SpreadsheetRequest {
    return {
      updateCells: {
        range: this.lockCellRange(),
        rows: [{ values: [stringCell(value)] }],
        fields: "userEnteredValue",
      },
    };
  }

  private lockCellRange() {
    return { sheetId: CONTROL_SHEET_ID, startRowIndex: LOCK_STATE_ROW_INDEX, endRowIndex: LOCK_STATE_ROW_INDEX + 1, startColumnIndex: LOCK_STATE_COLUMN_INDEX, endColumnIndex: LOCK_STATE_COLUMN_INDEX + 1 };
  }

  private currentEntry(): { letter: LockLetter; expiresAtSec: string } | null {
    const letter = lockLetter(this.localLock);
    if (letter === null || this.expiresAtSec === null) return null;
    return { letter, expiresAtSec: this.expiresAtSec };
  }

  private entry(letter: LockLetter, expiresAtSec: string): string { return `${letter}:${expiresAtSec}:${this.ownerKey};`; }
  private statePrefix(dataSheetId: number): string { return `${escapeRegex(LOCK_CELL_PREFIX)}D:${dataSheetId}\\|`; }
  private anyStatePrefix(): string { return `${escapeRegex(LOCK_CELL_PREFIX)}D:[0-9]+\\|`; }
  private hasUsableLocalLease(): boolean { return this.expiresAtSec !== null && Date.now() < Number(this.expiresAtSec) * 1000; }
  private shouldRenewLocalLease(): boolean { return this.expiresAtSec !== null && Date.now() >= Number(this.expiresAtSec) * 1000 - this.renewBeforeExpiryMs; }
  private dropExpiredLocalLock(): void { if (this.localLock !== SQLITE_LOCK_NONE && !this.hasUsableLocalLease()) this.clearLocalState(); }
  private nextExpiresAtSec(): string { return fixedWidthUnixSec(Date.now() + this.leaseMs); }
}

function parseControlState(value: unknown): ControlState | null {
  if (typeof value !== "string" || !value.startsWith(LOCK_CELL_PREFIX)) return null;

  const match = new RegExp(`^${escapeRegex(LOCK_CELL_PREFIX)}D:([0-9]+)\\|(.*)$`).exec(value);
  if (match === null) return null;

  const dataSheetId = Number(match[1]);
  if (!Number.isSafeInteger(dataSheetId) || dataSheetId < 0) return null;

  const entriesRaw = match[2];
  const entries: ControlEntry[] = [];
  const entryRegex = /(S|R|P|X|B):([0-9]{10}):([^;]+);/g;
  let offset = 0;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryRegex.exec(entriesRaw)) !== null) {
    if (entryMatch.index !== offset) return null;
    const rawLetter = entryMatch[1];
    const letter = rawLetter as LockLetter | "B";
    entries.push({ letter, expiresAtSec: entryMatch[2], owner: entryMatch[3] });
    offset = entryRegex.lastIndex;
  }

  if (offset !== entriesRaw.length) return null;
  return { dataSheetId, entries };
}

function controlValueFromBatchUpdate(response: SpreadsheetBatchUpdateResult): unknown {
  for (const sheet of response.updatedSpreadsheet?.sheets ?? []) {
    for (const data of sheet.data ?? []) {
      for (const row of data.rowData ?? []) {
        for (const cell of row.values ?? []) {
          const value = cell.userEnteredValue ?? cell.effectiveValue;
          if (value?.stringValue !== undefined) return value.stringValue;
          if (value?.numberValue !== undefined) return value.numberValue;
          if (value?.boolValue !== undefined) return value.boolValue;
          if (cell.formattedValue !== undefined) return cell.formattedValue;
        }
      }
    }
  }
  return undefined;
}

function changed(response: SpreadsheetBatchUpdateResult, replyIndex: number): boolean { return response.replies?.[replyIndex]?.findReplace?.occurrencesChanged === 1; }
function lockLetter(lock: number): LockLetter | null { if (lock === SQLITE_LOCK_SHARED) return "S"; if (lock === SQLITE_LOCK_RESERVED) return "R"; if (lock === SQLITE_LOCK_PENDING) return "P"; if (lock === SQLITE_LOCK_EXCLUSIVE) return "X"; return null; }
function normalizeLock(lock: number): number { if (lock === SQLITE_LOCK_SHARED || lock === SQLITE_LOCK_RESERVED || lock === SQLITE_LOCK_PENDING || lock === SQLITE_LOCK_EXCLUSIVE) return lock; throw new Error(`Invalid SQLite lock level ${lock}`); }
function normalizeUnlockTarget(lock: number): number { if (lock === SQLITE_LOCK_NONE || lock === SQLITE_LOCK_SHARED) return lock; throw new Error(`Invalid SQLite unlock target ${lock}`); }
function fixedWidthUnixSec(ms: number): string { return Math.max(0, Math.floor(ms / 1000)).toString().padStart(10, "0"); }
function fixedWidthDecimalLeRegex(max: string): string { const alternatives: string[] = []; for (let i = 0; i < max.length; i++) { const digit = Number(max[i]); if (digit === 0) continue; alternatives.push(`${max.slice(0, i)}${digit === 1 ? "0" : `[0-${digit - 1}]`}${max.length - i - 1 === 0 ? "" : `[0-9]{${max.length - i - 1}}`}`); } alternatives.push(max); return `(?:${alternatives.join("|")})`; }
function randomOwnerKey(): string { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase(); }
function retryDelay(attempt: number): number { const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.min(attempt, 4)); return exponential + Math.floor(Math.random() * BASE_RETRY_DELAY_MS); }
function stringCell(value: string): CellData { return { userEnteredValue: { stringValue: value } }; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
