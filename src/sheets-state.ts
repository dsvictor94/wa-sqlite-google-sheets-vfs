import { GoogleSdkSheetsClient, type SpreadsheetBatchUpdateResult, type SpreadsheetRequest } from "./google-sheets-client.js";

export type GoogleSheetsLeaseOptions = { databaseId: string; blockSheetName?: string; leaseMs?: number; lockTimeoutMs?: number; lockReleaseDelayMs?: number };
export type GoogleSheetsWriteBatchRenewal = { requests: SpreadsheetRequest[]; replyIndex: number; expiresAtSec: string };

export class GoogleSheetsLease {
  constructor(private readonly client: GoogleSdkSheetsClient, options: GoogleSheetsLeaseOptions) { void this.client; void options; }
  async acquire(): Promise<boolean> { return true; }
  completeWriteBatchRenewal(_response: SpreadsheetBatchUpdateResult, _renewal: GoogleSheetsWriteBatchRenewal): void {}
}
