import {
  BLOCK_SHEET_INITIAL_COLUMNS,
  BLOCK_SHEET_INITIAL_ROWS,
  CONTROL_SHEET_ID,
  CONTROL_SHEET_NAME,
  DATA_SHEET_NAME,
  INITIAL_DATA_SHEET_ID,
  LOCK_CELL_PREFIX,
  LOCK_STATE_CELL,
} from "./constants.js";
import { formatControlState, GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { quoteSheetName } from "./util.js";

export async function ensureGoogleSheetsVfsTabs(spreadsheetId: string): Promise<void> {
  const client = new GoogleSdkSheetsClient(spreadsheetId);

  await client.ensureSheetTabs([
    { title: CONTROL_SHEET_NAME, rows: 1, cols: 1, sheetId: CONTROL_SHEET_ID },
    { title: DATA_SHEET_NAME, rows: BLOCK_SHEET_INITIAL_ROWS, cols: BLOCK_SHEET_INITIAL_COLUMNS, sheetId: INITIAL_DATA_SHEET_ID },
  ]);

  const controlSheetId = await client.getSheetId(CONTROL_SHEET_NAME);
  if (controlSheetId !== CONTROL_SHEET_ID) {
    throw new Error(`Google Sheets VFS Control tab must use fixed sheet id ${CONTROL_SHEET_ID}, got ${controlSheetId}`);
  }

  const dataSheetId = await client.getSheetId(DATA_SHEET_NAME);
  const control = quoteSheetName(CONTROL_SHEET_NAME);
  const [cell] = await client.batchGet([`${control}!${LOCK_STATE_CELL}`]);
  const current = cell?.values?.[0]?.[0];

  if (typeof current !== "string" || !current.startsWith(LOCK_CELL_PREFIX)) {
    await client.batchUpdate([{ range: `${control}!${LOCK_STATE_CELL}`, values: [[formatControlState(dataSheetId)]] }]);
  }
}
