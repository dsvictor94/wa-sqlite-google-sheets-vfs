import {
  BLOCK_SHEET_INITIAL_COLUMNS,
  BLOCK_SHEET_INITIAL_ROWS,
  DEFAULT_BLOCK_SHEET_NAME,
  DEFAULT_LOCK_SHEET_NAME,
  LOCK_COLUMNS,
  LOCK_HEADER_RANGE,
  LOCK_INITIAL_ROWS,
} from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { quoteSheetName } from "./util.js";

export async function ensureGoogleSheetsVfsTabs(spreadsheetId: string): Promise<void> {
  const client = new GoogleSdkSheetsClient(spreadsheetId);
  await client.ensureSheetTabs([
    { title: DEFAULT_LOCK_SHEET_NAME, rows: LOCK_INITIAL_ROWS, cols: LOCK_COLUMNS },
    { title: DEFAULT_BLOCK_SHEET_NAME, rows: BLOCK_SHEET_INITIAL_ROWS, cols: BLOCK_SHEET_INITIAL_COLUMNS },
  ]);
  await client.batchUpdate([
    {
      range: `${quoteSheetName(DEFAULT_LOCK_SHEET_NAME)}!${LOCK_HEADER_RANGE}`,
      values: [["databaseId", "ownerId", "token", "createdAtMs", "leaseUntilMs", "releasedAtMs", "type", "note"]],
    },
  ]);
}
