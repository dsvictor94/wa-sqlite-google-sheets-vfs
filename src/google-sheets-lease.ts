import { DEFAULT_LEASE_MS, DEFAULT_LOCK_SHEET_NAME, DEFAULT_LOCK_TIMEOUT_MS } from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { parseAppendedRow, quoteSheetName, sleep } from "./util.js";

export type GoogleSheetsLeaseOptions = {
  databaseId: string;
  lockSheetName?: string;
  leaseMs?: number;
  lockTimeoutMs?: number;
};

const RELEASED_AT_COLUMN = "F";

export class GoogleSheetsLease {
  private readonly ownerId = crypto.randomUUID();
  private readonly sheetRangePrefix: string;
  private readonly leaseMs: number;
  private readonly lockTimeoutMs: number;
  private lockToken: string | null = null;
  private lockRow: number | null = null;
  private leaseUntil = 0;

  constructor(
    private readonly client: GoogleSdkSheetsClient,
    private readonly options: GoogleSheetsLeaseOptions,
  ) {
    this.sheetRangePrefix = quoteSheetName(options.lockSheetName ?? DEFAULT_LOCK_SHEET_NAME);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  get isHeld(): boolean {
    return this.lockToken !== null && Date.now() < this.leaseUntil - 1_000;
  }

  async acquire(): Promise<boolean> {
    if (this.isHeld) return true;

    this.lockToken = crypto.randomUUID();
    this.leaseUntil = Date.now() + this.leaseMs;

    const response = await this.client.append(`${this.sheetRangePrefix}!A:H`, [[
      this.options.databaseId,
      this.ownerId,
      this.lockToken,
      Date.now(),
      this.leaseUntil,
      "",
      "claim",
      userAgent(),
    ]]);
    this.lockRow = parseAppendedRow(response.updates?.updatedRange);

    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() < deadline) {
      const winner = await this.currentWinner();
      if (winner === this.lockToken) return true;
      await sleep(250);
    }

    await this.release().catch(() => undefined);
    return false;
  }

  async release(): Promise<void> {
    if (this.lockRow !== null) {
      await this.client.batchUpdate([{
        range: `${this.sheetRangePrefix}!${RELEASED_AT_COLUMN}${this.lockRow}`,
        values: [[Date.now()]],
      }]);
    }

    this.lockToken = null;
    this.lockRow = null;
    this.leaseUntil = 0;
  }

  private async currentWinner(): Promise<string | null> {
    const [range] = await this.client.batchGet([`${this.sheetRangePrefix}!A2:H`]);
    const now = Date.now();
    const rows = range?.values ?? [];

    for (const row of rows) {
      const [databaseId, , token, , leaseUntil, releasedAt, type] = row;
      const isClaim = type === "claim";
      const isForDatabase = databaseId === this.options.databaseId;
      const isReleased = releasedAt !== undefined && releasedAt !== null && releasedAt !== "";
      const isExpired = Number(leaseUntil) <= now;

      if (isForDatabase && isClaim && !isReleased && !isExpired) return String(token);
    }

    return null;
  }
}

function userAgent(): string {
  return globalThis.navigator?.userAgent ?? "unknown";
}
