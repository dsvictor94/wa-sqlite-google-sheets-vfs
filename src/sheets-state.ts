import { type SpreadsheetRequest } from "./google-sheets-client.js";

export type GoogleSheetsWriteBatchRenewal = { requests: SpreadsheetRequest[]; replyIndex: number; expiresAtSec: string };

export class GoogleSheetsLease {
  async acquire(): Promise<boolean> { return true; }
}
