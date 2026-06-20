import {
  DEFAULT_LEASE_MS,
  DEFAULT_LOCK_RELEASE_DELAY_MS,
  DEFAULT_LOCK_SHEET_NAME,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_STATE_CELL,
  LOCK_STATE_COLUMN_INDEX,
  LOCK_STATE_ROW_INDEX,
} from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { quoteSheetName, sleep } from "./util.js";

export type GoogleSheetsLeaseOptions = {
  databaseId: string;
  lockSheetName?: string;
  leaseMs?: number;
  lockTimeoutMs?: number;
  lockReleaseDelayMs?: number;
};

type LockCellState = {
  version: 1;
  databaseId: string;
  ownerId: string;
  token: string;
  leaseUntilMs: number;
  revision: number;
};

type ObservedLockCell = {
  raw: string;
  state: LockCellState;
};

type HeldLease = {
  token: string;
  leaseUntilMs: number;
  revision: number;
};

const LOCK_STATE_VERSION = 1;
const BASE_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 250;

export class GoogleSheetsLease {
  private readonly ownerId = crypto.randomUUID();
  private readonly lockSheetName: string;
  private readonly sheetRangePrefix: string;
  private readonly leaseMs: number;
  private readonly lockTimeoutMs: number;
  private readonly releaseDelayMs: number;
  private readonly renewBeforeExpiryMs: number;
  private heldLease: HeldLease | null = null;
  private releaseTimer: number | undefined;

  constructor(
    private readonly client: GoogleSdkSheetsClient,
    private readonly options: GoogleSheetsLeaseOptions,
  ) {
    this.lockSheetName = options.lockSheetName ?? DEFAULT_LOCK_SHEET_NAME;
    this.sheetRangePrefix = quoteSheetName(this.lockSheetName);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.releaseDelayMs = options.lockReleaseDelayMs ?? DEFAULT_LOCK_RELEASE_DELAY_MS;
    this.renewBeforeExpiryMs = Math.min(5_000, Math.max(1_000, Math.floor(this.leaseMs / 3)));
  }

  get isHeld(): boolean {
    return this.heldLease !== null && Date.now() < this.heldLease.leaseUntilMs - this.renewBeforeExpiryMs;
  }

  async acquire(): Promise<boolean> {
    this.cancelScheduledRelease();
    if (this.isHeld) return true;

    const deadline = Date.now() + this.lockTimeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      const observed = await this.readLockCell();
      const now = Date.now();

      if (this.canAcquireObservedState(observed.state, now)) {
        const next = this.nextHeldState(observed.state, now);
        if (await this.compareAndSwap(observed.raw, serializeLockState(next))) {
          this.heldLease = {
            token: next.token,
            leaseUntilMs: next.leaseUntilMs,
            revision: next.revision,
          };
          return true;
        }
      }

      await sleep(retryDelay(attempt++));
    }

    return false;
  }

  async releaseSoon(): Promise<void> {
    if (this.heldLease === null) return;

    this.cancelScheduledRelease();
    if (this.releaseDelayMs <= 0) {
      await this.release();
      return;
    }

    this.releaseTimer = globalThis.setTimeout(() => {
      this.releaseTimer = undefined;
      void this.release().catch(() => undefined);
    }, this.releaseDelayMs);
  }

  async release(): Promise<void> {
    this.cancelScheduledRelease();

    const held = this.heldLease;
    if (held === null) return;

    try {
      const observed = await this.readLockCell();
      if (this.isObservedLeaseHeldByThisOwner(observed.state, held.token)) {
        const next = unlockedState(this.options.databaseId, observed.state.revision + 1);
        await this.compareAndSwap(observed.raw, serializeLockState(next));
      }
    } finally {
      this.heldLease = null;
    }
  }

  private async readLockCell(): Promise<ObservedLockCell> {
    const [range] = await this.client.batchGet([`${this.sheetRangePrefix}!${LOCK_STATE_CELL}`]);
    const rawValue = range?.values?.[0]?.[0];
    const raw = rawValue === undefined || rawValue === null ? "" : String(rawValue);

    return {
      raw,
      state: parseLockState(raw, this.options.databaseId),
    };
  }

  private canAcquireObservedState(state: LockCellState, now: number): boolean {
    return state.token === "" || state.leaseUntilMs <= now || this.isObservedLeaseHeldByThisOwner(state, this.heldLease?.token);
  }

  private isObservedLeaseHeldByThisOwner(state: LockCellState, token: string | undefined): boolean {
    return token !== undefined && state.ownerId === this.ownerId && state.token === token;
  }

  private nextHeldState(previous: LockCellState, now: number): LockCellState {
    const currentToken = this.heldLease?.token;
    const reusingCurrentLease = this.isObservedLeaseHeldByThisOwner(previous, currentToken);

    return {
      version: LOCK_STATE_VERSION,
      databaseId: this.options.databaseId,
      ownerId: this.ownerId,
      token: reusingCurrentLease && currentToken ? currentToken : crypto.randomUUID(),
      leaseUntilMs: now + this.leaseMs,
      revision: previous.revision + 1,
    };
  }

  private async compareAndSwap(previousRaw: string, nextRaw: string): Promise<boolean> {
    const sheetId = await this.client.getSheetId(this.lockSheetName);
    const response = await this.client.spreadsheetBatchUpdate([
      {
        findReplace: {
          find: previousRaw,
          replacement: nextRaw,
          matchCase: true,
          matchEntireCell: true,
          searchByRegex: false,
          range: {
            sheetId,
            startRowIndex: LOCK_STATE_ROW_INDEX,
            endRowIndex: LOCK_STATE_ROW_INDEX + 1,
            startColumnIndex: LOCK_STATE_COLUMN_INDEX,
            endColumnIndex: LOCK_STATE_COLUMN_INDEX + 1,
          },
        },
      },
    ]);

    return response.replies?.[0]?.findReplace?.occurrencesChanged === 1;
  }

  private cancelScheduledRelease(): void {
    if (this.releaseTimer === undefined) return;
    globalThis.clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }
}

function parseLockState(raw: string, databaseId: string): LockCellState {
  if (raw === "") return unlockedState(databaseId, 0);

  try {
    const parsed = JSON.parse(raw) as Partial<LockCellState>;
    if (
      parsed.version === LOCK_STATE_VERSION &&
      typeof parsed.databaseId === "string" &&
      typeof parsed.ownerId === "string" &&
      typeof parsed.token === "string" &&
      isNonNegativeFiniteNumber(parsed.leaseUntilMs) &&
      Number.isSafeInteger(parsed.revision) &&
      parsed.revision >= 0
    ) {
      return parsed as LockCellState;
    }
  } catch {
    // Legacy append-log rows store the database id in A2. Treat unknown cell
    // contents as an expired, unlocked state and replace them with the new
    // single-cell format through the same compare-and-swap path.
  }

  return unlockedState(databaseId, 0);
}

function unlockedState(databaseId: string, revision: number): LockCellState {
  return {
    version: LOCK_STATE_VERSION,
    databaseId,
    ownerId: "",
    token: "",
    leaseUntilMs: 0,
    revision,
  };
}

function serializeLockState(state: LockCellState): string {
  return JSON.stringify({
    version: state.version,
    databaseId: state.databaseId,
    ownerId: state.ownerId,
    token: state.token,
    leaseUntilMs: state.leaseUntilMs,
    revision: state.revision,
  });
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.min(attempt, 4));
  return exponential + Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
}
