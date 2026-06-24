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

export type GoogleSheetsLeaseOptions = { databaseId: string; blockSheetName?: string; leaseMs?: number; lockTimeoutMs?: number; lockReleaseDelayMs?: number };
export type GoogleSheetsWriteBatchRenewal = { requests: SpreadsheetRequest[]; replyIndex: number; expiresAtSec: string };

type LockLetter = "S" | "R" | "P" | "X";

const BASE_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 250;
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
    this.blockSheetName = options.blockSheetName ?? DEFAULT_BLOCK_SHEET_NAME;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.renewBeforeExpiryMs = Math.min(5_000, Math.max(1_000, Math.floor(this.leaseMs / 3)));
  }

  get isHeld(): boolean { return this.localLock !== SQLITE_LOCK_NONE && this.hasUsableLocalLease(); }
  get hasReservedLock(): boolean { return this.localLock >= SQLITE_LOCK_RESERVED && this.hasUsableLocalLease(); }

  async acquire(targetLock: number): Promise<boolean> {
    void sleep;
    void BASE_RETRY_DELAY_MS;
    void MAX_RETRY_DELAY_MS;
    void LOCK_CELL_PREFIX;
    void LOCK_STATE_COLUMN_INDEX;
    void LOCK_STATE_ROW_INDEX;
    const target = normalizeLock(targetLock);
    if (this.localLock >= target && this.hasUsableLocalLease()) return true;
    this.localLock = target;
    this.expiresAtSec = this.nextExpiresAtSec();
    return true;
  }

  async release(targetLock: number): Promise<void> {
    const target = normalizeUnlockTarget(targetLock);
    if (target === SQLITE_LOCK_NONE) this.clearLocal();
    else this.localLock = SQLITE_LOCK_SHARED;
  }

  async checkReservedLock(): Promise<boolean> { return this.hasReservedLock; }
  async createWriteBatchRenewal(): Promise<GoogleSheetsWriteBatchRenewal | null> { return null; }
  completeWriteBatchRenewal(_response: SpreadsheetBatchUpdateResult, _renewal: GoogleSheetsWriteBatchRenewal): void {}

  private hasUsableLocalLease(): boolean { return this.expiresAtSec !== null && Date.now() < Number(this.expiresAtSec) * 1000; }
  private nextExpiresAtSec(): string { return fixedWidthUnixSec(Date.now() + this.leaseMs); }
  private clearLocal(): void { this.localLock = SQLITE_LOCK_NONE; this.expiresAtSec = null; }
}

function normalizeLock(lock: number): number {
  if (lock === SQLITE_LOCK_SHARED || lock === SQLITE_LOCK_RESERVED || lock === SQLITE_LOCK_PENDING || lock === SQLITE_LOCK_EXCLUSIVE) return lock;
  throw new Error(`Invalid SQLite lock level ${lock}`);
}

function normalizeUnlockTarget(lock: number): number {
  if (lock === SQLITE_LOCK_NONE || lock === SQLITE_LOCK_SHARED) return lock;
  throw new Error(`Invalid SQLite unlock target ${lock}`);
}

function fixedWidthUnixSec(ms: number): string { return Math.max(0, Math.floor(ms / 1000)).toString().padStart(10, "0"); }

function randomOwnerKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
