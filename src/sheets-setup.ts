import { BLOCK_SHEET_INITIAL_COLUMNS, BLOCK_SHEET_INITIAL_ROWS, DEFAULT_BLOCK_SHEET_NAME, LOCK_CELL_PREFIX, LOCK_STATE_CELL } from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { quoteSheetName } from "./util.js";

export async function ensureGoogleSheetsVfsTabs(spreadsheetId: string): Promise<void> {
  const client = new GoogleSdkSheetsClient(spreadsheetId);
  await client.ensureSheetTabs([
    { title: DEFAULT_BLOCK_SHEET_NAME, rows: BLOCK_SHEET_INITIAL_ROWS, cols: BLOCK_SHEET_INITIAL_COLUMNS },
  ]);
  await client.batchUpdate([
    {
      range: `${quoteSheetName(DEFAULT_BLOCK_SHEET_NAME)}!${LOCK_STATE_CELL}`,
      values: [[LOCK_CELL_PREFIX]],
    },
  ]);
}
