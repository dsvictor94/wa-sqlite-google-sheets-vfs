import { BLOCK_SHEET_INITIAL_COLUMNS, BLOCK_SHEET_INITIAL_ROWS, DEFAULT_BLOCK_SHEET_NAME, LOCK_CELL_PREFIX, LOCK_STATE_CELL } from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { quoteSheetName } from "./util.js";

export async function ensureGoogleSheetsVfsTabs(spreadsheetId: string): Promise<void> {
  const client = new GoogleSdkSheetsClient(spreadsheetId);
  const sheet = quoteSheetName(DEFAULT_BLOCK_SHEET_NAME);

  await client.ensureSheetTabs([
    { title: DEFAULT_BLOCK_SHEET_NAME, rows: BLOCK_SHEET_INITIAL_ROWS, cols: BLOCK_SHEET_INITIAL_COLUMNS },
  ]);

  const [cell] = await client.batchGet([`${sheet}!${LOCK_STATE_CELL}`]);
  const current = cell?.values?.[0]?.[0];
  if (current === undefined || current === null || current === "") {
    await client.batchUpdate([{ range: `${sheet}!${LOCK_STATE_CELL}`, values: [[LOCK_CELL_PREFIX]] }]);
  }
}
