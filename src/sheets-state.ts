import * as SQLite from "wa-sqlite/src/sqlite-constants.js";
import {
  DEFAULT_BLOCK_SHEET_NAME,
  DEFAULT_LEASE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_CELL_PREFIX,
  LOCK_STATE_COLUMN_INDEX,
  LOCK_STATE_ROW_INDEX,
} from "./constants.js";
import { GoogleSdkSheetsClient, type SpreadsheetBatchUpdateResult, type SpreadsheetRequest } from "./google-sheets-client.js";
import { sleep } from "./util.js";

export type GoogleSheetsLeaseOptions = { databaseId: string; blockSheetName?: string; lockSheetName?: string; leaseMs?: number; lockTimeoutMs?: number; lockReleaseDelayMs?: number };
export type GoogleSheetsWriteBatchRenewal = { requests: SpreadsheetRequest[]; replyIndex: number; expiresAtSec: string };

type LockLetter = "S" | "R" | "P" | "X";

const BASE_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 250;
const EXP = "[0-9]{10}";
const OWNER = "[^;]+";
const ENTRY = `[SRPX]:${EXP}:${OWNER};`;
const PREFIX = "LSV1\\|";
const SQLITE_LOCK_NONE = SQLite.SQLITE_LOCK_NONE;
const SQLITE_LOCK_SHARED = SQLite.SQLITE_LOCK_SHARED;
const SQLITE_LOCK_RESERVED = SQLite.SQLITE_LOCK_RESERVED;
const SQLITE_LOCK_PENDING = SQLite.SQLITE_LOCK_PENDING;
const SQLITE_LOCK_EXCLUSIVE = SQLite.SQLITE_LOCK_EXCLUSIVE;

export class GoogleSheetsLease {
  private readonly ownerKey = randomOwnerKey();
  private readonly blockSheetName: string;
  private readonly leaseMs: number;
  private readonly lockTimeoutMs: number;
  private readonly renewBeforeExpiryMs: number;
  private localLock = SQLITE_LOCK_NONE;
  private expiresAtSec: string | null = null;

  constructor(private readonly client: GoogleSdkSheetsClient, options: GoogleSheetsLeaseOptions) {
    void options.databaseId;
    void options.lockReleaseDelayMs;
    this.blockSheetName = options.blockSheetName ?? options.lockSheetName ?? DEFAULT_BLOCK_SHEET_NAME;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.renewBeforeExpiryMs = Math.min(5_000, Math.max(1_000, Math.floor(this.leaseMs / 3)));
  }

  get isHeld(): boolean { return this.localLock !== SQLITE_LOCK_NONE && this.hasUsableLocalLease(); }
  get hasReservedLock(): boolean { return this.localLock >= SQLITE_LOCK_RESERVED && this.hasUsableLocalLease(); }

  async acquire(targetLock = SQLITE_LOCK_EXCLUSIVE): Promise<boolean> {
    const target = normalizeLock(targetLock);
    if (this.localLock >= target && this.hasUsableLocalLease()) return await this.renewCurrentLockIfNeeded();
    this.dropExpiredLocalLock();

    const deadline = Date.now() + this.lockTimeoutMs;
    let attempt = 0;
    do {
      const sheetId = await this.client.getSheetId(this.blockSheetName);
      const expiresAtSec = this.nextExpiresAtSec();
      const response = await this.client.spreadsheetBatchUpdate([this.cleanupExpiredRequest(sheetId), ...this.acquireRequests(sheetId, target, expiresAtSec)]);
      if (this.applyAcquireResponse(target, expiresAtSec, response)) return true;
      await sleep(retryDelay(attempt++));
    } while (Date.now() < deadline);
    return false;
  }

  async release(targetLock = SQLITE_LOCK_NONE): Promise<void> {
    const target = normalizeUnlockTarget(targetLock);
    if (this.localLock <= target) return;

    const sheetId = await this.client.getSheetId(this.blockSheetName);
    const requests: SpreadsheetRequest[] = [];
    let downgradeReplyIndex: number | null = null;

    if (target === SQLITE_LOCK_NONE) {
      requests.push(this.regexFindReplaceRequest(sheetId, `[SRPX]:${EXP}:${this.ownerKey};`, "", false));
    } else {
      const current = this.currentEntry();
      if (current === null) {
        this.clearLocal();
        throw new Error("Google Sheets VFS cannot downgrade a missing local lock entry");
      }

      downgradeReplyIndex = requests.length;
      requests.push(this.exactFindReplaceRequest(sheetId, this.entry(current.letter, current.expiresAtSec), this.entry("S", current.expiresAtSec), false));
    }

    requests.push(this.cleanupExpiredRequest(sheetId));
    const response = await this.client.spreadsheetBatchUpdate(requests);

    if (target === SQLITE_LOCK_NONE) {
      this.clearLocal();
      return;
    }

    if (downgradeReplyIndex === null || !changed(response, downgradeReplyIndex)) {
      this.clearLocal();
      throw new Error("Google Sheets VFS lock downgrade failed; local lease no longer matches durable state");
    }

    this.localLock = SQLITE_LOCK_SHARED;
  }

  async checkReservedLock(): Promise<boolean> {
    if (this.hasReservedLock) return true;
    const sheetId = await this.client.getSheetId(this.blockSheetName);
    const response = await this.client.spreadsheetBatchUpdate([
      this.cleanupExpiredRequest(sheetId),
      this.regexFindReplaceRequest(sheetId, `^(${PREFIX}(?:${ENTRY})*[RPX]:${EXP}:${OWNER};(?:${ENTRY})*)$`, "$1!", true),
      this.regexFindReplaceRequest(sheetId, "!", "", false),
    ]);
    return changed(response, 1);
  }

  async createWriteBatchRenewal(): Promise<GoogleSheetsWriteBatchRenewal | null> {
    if (!(await this.acquire(SQLITE_LOCK_EXCLUSIVE))) return null;
    const current = this.currentEntry();
    if (current === null || current.letter !== "X") return null;
    const sheetId = await this.client.getSheetId(this.blockSheetName);
    const expiresAtSec = this.nextExpiresAtSec();
    return {
      requests: [this.regexFindReplaceRequest(sheetId, `^${PREFIX}${this.entry("X", current.expiresAtSec)}$`, `${LOCK_CELL_PREFIX}${this.entry("X", expiresAtSec)}`, true)],
      replyIndex: 0,
      expiresAtSec,
    };
  }

  completeWriteBatchRenewal(response: SpreadsheetBatchUpdateResult, renewal: GoogleSheetsWriteBatchRenewal): void {
    if (!changed(response, renewal.replyIndex)) {
      this.clearLocal();
      throw new Error("Google Sheets VFS exclusive lock renewal failed during persistent write batch");
    }
    this.localLock = SQLITE_LOCK_EXCLUSIVE;
    this.expiresAtSec = renewal.expiresAtSec;
  }

  private async renewCurrentLockIfNeeded(): Promise<boolean> {
    if (!this.shouldRenewLocalLease()) return true;
    const current = this.currentEntry();
    if (current === null || !this.hasUsableLocalLease()) return false;
    const sheetId = await this.client.getSheetId(this.blockSheetName);
    const expiresAtSec = this.nextExpiresAtSec();
    const response = await this.client.spreadsheetBatchUpdate([
      this.cleanupExpiredRequest(sheetId),
      this.exactFindReplaceRequest(sheetId, this.entry(current.letter, current.expiresAtSec), this.entry(current.letter, expiresAtSec), false),
    ]);
    if (!changed(response, 1)) {
      this.clearLocal();
      return false;
    }
    this.expiresAtSec = expiresAtSec;
    return true;
  }

  private acquireRequests(sheetId: number, target: number, expiresAtSec: string): SpreadsheetRequest[] {
    const otherOwner = `(?!${this.ownerKey};)${OWNER}`;
    const otherS = `S:${EXP}:${otherOwner};`;
    const otherSR = `(?:S|R):${EXP}:${otherOwner};`;
    if (target === SQLITE_LOCK_SHARED) return [this.regexFindReplaceRequest(sheetId, `^${PREFIX}((?:${otherSR})*)(?:S:${EXP}:${this.ownerKey};)?((?:${otherSR})*)$`, `${LOCK_CELL_PREFIX}$1${this.entry("S", expiresAtSec)}$2`, true)];
    if (target === SQLITE_LOCK_RESERVED) return [this.regexFindReplaceRequest(sheetId, `^${PREFIX}((?:${otherS})*)(?:(?:S|R):${EXP}:${this.ownerKey};)?((?:${otherS})*)$`, `${LOCK_CELL_PREFIX}$1${this.entry("R", expiresAtSec)}$2`, true)];
    if (target === SQLITE_LOCK_PENDING) return [this.regexFindReplaceRequest(sheetId, `^${PREFIX}((?:${otherS})*)(?:(?:S|R|P):${EXP}:${this.ownerKey};)?((?:${otherS})*)$`, `${LOCK_CELL_PREFIX}$1${this.entry("P", expiresAtSec)}$2`, true)];
    return [
      this.regexFindReplaceRequest(sheetId, `^${PREFIX}((?:${otherS})*)(?:(?:S|R|P):${EXP}:${this.ownerKey};)?((?:${otherS})*)$`, `${LOCK_CELL_PREFIX}$1${this.entry("P", expiresAtSec)}$2`, true),
      this.regexFindReplaceRequest(sheetId, `^${PREFIX}P:${expiresAtSec}:${this.ownerKey};$`, `${LOCK_CELL_PREFIX}${this.entry("X", expiresAtSec)}`, true),
    ];
  }

  private applyAcquireResponse(target: number, expiresAtSec: string, response: SpreadsheetBatchUpdateResult): boolean {
    if (target === SQLITE_LOCK_EXCLUSIVE) {
      if (changed(response, 2)) { this.localLock = SQLITE_LOCK_EXCLUSIVE; this.expiresAtSec = expiresAtSec; return true; }
      if (changed(response, 1)) { this.localLock = SQLITE_LOCK_PENDING; this.expiresAtSec = expiresAtSec; }
      return false;
    }
    if (!changed(response, 1)) return false;
    this.localLock = target;
    this.expiresAtSec = expiresAtSec;
    return true;
  }

  private cleanupExpiredRequest(sheetId: number): SpreadsheetRequest {
    const cutoffSec = fixedWidthUnixSec(Date.now());
    return this.regexFindReplaceRequest(sheetId, `[SRPX]:(?:${fixedWidthDecimalLeRegex(cutoffSec)}):${OWNER};`, "", false);
  }

  private regexFindReplaceRequest(sheetId: number, find: string, replacement: string, matchEntireCell: boolean): SpreadsheetRequest {
    return { findReplace: { find, replacement, matchCase: true, matchEntireCell, searchByRegex: true, includeFormulas: false, range: this.lockCellRange(sheetId) } };
  }

  private exactFindReplaceRequest(sheetId: number, find: string, replacement: string, matchEntireCell: boolean): SpreadsheetRequest {
    return { findReplace: { find, replacement, matchCase: true, matchEntireCell, searchByRegex: false, includeFormulas: false, range: this.lockCellRange(sheetId) } };
  }

  private lockCellRange(sheetId: number) {
    return { sheetId, startRowIndex: LOCK_STATE_ROW_INDEX, endRowIndex: LOCK_STATE_ROW_INDEX + 1, startColumnIndex: LOCK_STATE_COLUMN_INDEX, endColumnIndex: LOCK_STATE_COLUMN_INDEX + 1 };
  }

  private currentEntry(): { letter: LockLetter; expiresAtSec: string } | null {
    const letter = lockLetter(this.localLock);
    if (letter === null || this.expiresAtSec === null) return null;
    return { letter, expiresAtSec: this.expiresAtSec };
  }

  private entry(letter: LockLetter, expiresAtSec: string): string { return `${letter}:${expiresAtSec}:${this.ownerKey};`; }
  private hasUsableLocalLease(): boolean { return this.expiresAtSec !== null && Date.now() < Number(this.expiresAtSec) * 1000; }
  private shouldRenewLocalLease(): boolean { return this.expiresAtSec !== null && Date.now() >= Number(this.expiresAtSec) * 1000 - this.renewBeforeExpiryMs; }
  private dropExpiredLocalLock(): void { if (this.localLock !== SQLITE_LOCK_NONE && !this.hasUsableLocalLease()) this.clearLocal(); }
  private nextExpiresAtSec(): string { return fixedWidthUnixSec(Date.now() + this.leaseMs); }
  private clearLocal(): void { this.localLock = SQLITE_LOCK_NONE; this.expiresAtSec = null; }
}

function changed(response: SpreadsheetBatchUpdateResult, replyIndex: number): boolean { return response.replies?.[replyIndex]?.findReplace?.occurrencesChanged === 1; }
function lockLetter(lock: number): LockLetter | null { if (lock === SQLITE_LOCK_SHARED) return "S"; if (lock === SQLITE_LOCK_RESERVED) return "R"; if (lock === SQLITE_LOCK_PENDING) return "P"; if (lock === SQLITE_LOCK_EXCLUSIVE) return "X"; return null; }
function normalizeLock(lock: number): number { if (lock === SQLITE_LOCK_SHARED || lock === SQLITE_LOCK_RESERVED || lock === SQLITE_LOCK_PENDING || lock === SQLITE_LOCK_EXCLUSIVE) return lock; throw new Error(`Invalid SQLite lock level ${lock}`); }
function normalizeUnlockTarget(lock: number): number { if (lock === SQLITE_LOCK_NONE || lock === SQLITE_LOCK_SHARED) return lock; throw new Error(`Invalid SQLite unlock target ${lock}`); }
function fixedWidthUnixSec(ms: number): string { return Math.max(0, Math.floor(ms / 1000)).toString().padStart(10, "0"); }
function fixedWidthDecimalLeRegex(max: string): string { const alternatives: string[] = []; for (let i = 0; i < max.length; i++) { const digit = Number(max[i]); if (digit === 0) continue; alternatives.push(`${max.slice(0, i)}${digit === 1 ? "0" : `[0-${digit - 1}]`}${max.length - i - 1 === 0 ? "" : `[0-9]{${max.length - i - 1}}`}`); } alternatives.push(max); return `(?:${alternatives.join("|")})`; }
function randomOwnerKey(): string { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase(); }
function retryDelay(attempt: number): number { const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.min(attempt, 4)); return exponential + Math.floor(Math.random() * BASE_RETRY_DELAY_MS); }
