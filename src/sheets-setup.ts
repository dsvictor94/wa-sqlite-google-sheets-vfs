import { BLOCK_SHEET_INITIAL_COLUMNS, BLOCK_SHEET_INITIAL_ROWS, DEFAULT_BLOCK_SHEET_NAME, LOCK_CELL_PREFIX, LOCK_STATE_CELL } from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import type { GoogleSheetsVFSMetrics } from "./types.js";
import { quoteSheetName } from "./util.js";

export async function ensureGoogleSheetsVfsTabs(spreadsheetId: string, metrics?: GoogleSheetsVFSMetrics): Promise<void> {
  const client = new GoogleSdkSheetsClient(spreadsheetId, metrics);
  const sheet = quoteSheetName(DEFAULT_BLOCK_SHEET_NAME);

  await client.ensureSheetTabs([
    { title: DEFAULT_BLOCK_SHEET_NAME, rows: BLOCK_SHEET_INITIAL_ROWS, cols: BLOCK_SHEET_INITIAL_COLUMNS },
  ]);

  const [cell] = await client.batchGet([`${sheet}!${LOCK_STATE_CELL}`]);
  const current = cell?.values?.[0]?.[0];
  if (typeof current !== "string" || !current.startsWith(LOCK_CELL_PREFIX)) {
    await client.batchUpdate([{ range: `${sheet}!${LOCK_STATE_CELL}`, values: [[LOCK_CELL_PREFIX]] }]);
  }
}
