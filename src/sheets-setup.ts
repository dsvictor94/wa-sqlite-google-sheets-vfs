import { GoogleSdkSheetsClient } from "./google-sheets-client.js";

export async function ensureGoogleSheetsVfsTabs(spreadsheetId: string): Promise<void> {
  const client = new GoogleSdkSheetsClient(spreadsheetId);
  await client.ensureSheetTabs([
    { title: "__sqlite_lock", rows: 1000, cols: 8 },
    { title: "__sqlite_blocks", rows: 4102, cols: 258 },
  ]);
}
