import type { AppendResponse, CreatedSpreadsheet, ValueRange } from "./types.js";

declare const gapi: any;

export async function createGoogleSheetsVfsSpreadsheet(title = `wa-sqlite VFS demo ${new Date().toISOString()}`): Promise<CreatedSpreadsheet> {
  const response = await gapi.client.sheets.spreadsheets.create({
    resource: {
      properties: { title },
      sheets: [
        { properties: { title: "__sqlite_lock", gridProperties: { rowCount: 1000, columnCount: 8 } } },
        { properties: { title: "__sqlite_blocks", gridProperties: { rowCount: 4102, columnCount: 258 } } },
      ],
    },
  });

  const spreadsheetId = response.result.spreadsheetId as string;
  return {
    spreadsheetId,
    spreadsheetUrl: response.result.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

export class GoogleSdkSheetsClient {
  constructor(private readonly spreadsheetId: string) {}

  async ensureSheetTabs(tabs: Array<{ title: string; rows: number; cols: number }>): Promise<void> {
    const spreadsheet = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: "sheets.properties.title" });
    const existing = new Set((spreadsheet.result.sheets ?? []).map((sheet: any) => sheet.properties?.title).filter(Boolean));
    const requests = tabs.filter((tab) => !existing.has(tab.title)).map((tab) => ({ addSheet: { properties: { title: tab.title, gridProperties: { rowCount: tab.rows, columnCount: tab.cols } } } }));
    if (requests.length) await gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, resource: { requests } });
  }

  async batchGet(ranges: string[]): Promise<ValueRange[]> {
    if (!ranges.length) return [];
    const response = await gapi.client.sheets.spreadsheets.values.batchGet({ spreadsheetId: this.spreadsheetId, ranges, majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE" });
    return response.result.valueRanges ?? [];
  }

  async batchUpdate(data: Array<{ range: string; values: unknown[][] }>): Promise<void> {
    if (!data.length) return;
    await gapi.client.sheets.spreadsheets.values.batchUpdate({ spreadsheetId: this.spreadsheetId, resource: { valueInputOption: "RAW", data } });
  }

  async append(range: string, values: unknown[][]): Promise<AppendResponse> {
    const response = await gapi.client.sheets.spreadsheets.values.append({ spreadsheetId: this.spreadsheetId, range, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", resource: { values } });
    return response.result as AppendResponse;
  }
}
