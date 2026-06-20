import {
  BLOCK_SHEET_INITIAL_COLUMNS,
  BLOCK_SHEET_INITIAL_ROWS,
  DEFAULT_BLOCK_SHEET_NAME,
  DEFAULT_LOCK_SHEET_NAME,
  LOCK_COLUMNS,
  LOCK_HEADER_RANGE,
  LOCK_INITIAL_ROWS,
  LOCK_STATE_CELL,
} from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { quoteSheetName } from "./util.js";

const EMPTY_LOCK_STATE = JSON.stringify({
  version: 1,
  databaseId: "",
  ownerId: "",
  token: "",
  leaseUntilMs: 0,
  revision: 0,
});

export async function ensureGoogleSheetsVfsTabs(spreadsheetId: string): Promise<void> {
  const client = new GoogleSdkSheetsClient(spreadsheetId);
  const lockSheetRangePrefix = quoteSheetName(DEFAULT_LOCK_SHEET_NAME);

  await client.ensureSheetTabs([
    { title: DEFAULT_LOCK_SHEET_NAME, rows: LOCK_INITIAL_ROWS, cols: LOCK_COLUMNS },
    { title: DEFAULT_BLOCK_SHEET_NAME, rows: BLOCK_SHEET_INITIAL_ROWS, cols: BLOCK_SHEET_INITIAL_COLUMNS },
  ]);
  await client.batchUpdate([
    {
      range: `${lockSheetRangePrefix}!${LOCK_HEADER_RANGE}`,
      values: [["lockStateJson", "reserved", "reserved", "reserved", "reserved", "reserved", "reserved", "reserved"]],
    },
  ]);

  const [lockState] = await client.batchGet([`${lockSheetRangePrefix}!${LOCK_STATE_CELL}`]);
  const rawLockState = lockState?.values?.[0]?.[0];
  if (rawLockState === undefined || rawLockState === null || rawLockState === "") {
    await client.batchUpdate([
      {
        range: `${lockSheetRangePrefix}!${LOCK_STATE_CELL}`,
        values: [[EMPTY_LOCK_STATE]],
      },
    ]);
  }
}
