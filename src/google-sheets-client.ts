import {
  BLOCK_SHEET_INITIAL_COLUMNS,
  BLOCK_SHEET_INITIAL_ROWS,
  DEFAULT_BLOCK_SHEET_NAME,
  DEFAULT_LOCK_SHEET_NAME,
  LOCK_COLUMNS,
  LOCK_INITIAL_ROWS,
} from "./constants.js";
import type { AppendResponse, CreatedSpreadsheet, SheetValueUpdate, ValueRange } from "./types.js";

type GoogleApiResponse<T> = { result: T };

type GoogleSheetProperties = {
  title?: string;
  gridProperties?: {
    rowCount?: number;
    columnCount?: number;
  };
};

type GoogleSheet = {
  properties?: GoogleSheetProperties;
};

type SpreadsheetCreateResult = {
  spreadsheetId: string;
  spreadsheetUrl?: string;
};

type SpreadsheetGetResult = {
  sheets?: GoogleSheet[];
};

type GoogleSheetsApi = {
  spreadsheets: {
    create(request: {
      resource: {
        properties: { title: string };
        sheets: Array<{ properties: GoogleSheetProperties }>;
      };
    }): Promise<GoogleApiResponse<SpreadsheetCreateResult>>;
    get(request: {
      spreadsheetId: string;
      fields: string;
    }): Promise<GoogleApiResponse<SpreadsheetGetResult>>;
    batchUpdate(request: {
      spreadsheetId: string;
      resource: { requests: unknown[] };
    }): Promise<GoogleApiResponse<unknown>>;
    values: {
      batchGet(request: {
        spreadsheetId: string;
        ranges: string[];
        majorDimension: "ROWS";
        valueRenderOption: "UNFORMATTED_VALUE";
      }): Promise<GoogleApiResponse<{ valueRanges?: ValueRange[] }>>;
      batchUpdate(request: {
        spreadsheetId: string;
        resource: { valueInputOption: "RAW"; data: SheetValueUpdate[] };
      }): Promise<GoogleApiResponse<unknown>>;
      append(request: {
        spreadsheetId: string;
        range: string;
        valueInputOption: "RAW";
        insertDataOption: "INSERT_ROWS";
        resource: { values: SheetValueUpdate["values"] };
      }): Promise<GoogleApiResponse<AppendResponse>>;
    };
  };
};

declare const gapi: {
  client: {
    sheets: GoogleSheetsApi;
  };
};

export async function createGoogleSheetsVfsSpreadsheet(title = `wa-sqlite VFS demo ${new Date().toISOString()}`): Promise<CreatedSpreadsheet> {
  const response = await gapi.client.sheets.spreadsheets.create({
    resource: {
      properties: { title },
      sheets: [
        { properties: { title: DEFAULT_LOCK_SHEET_NAME, gridProperties: { rowCount: LOCK_INITIAL_ROWS, columnCount: LOCK_COLUMNS } } },
        { properties: { title: DEFAULT_BLOCK_SHEET_NAME, gridProperties: { rowCount: BLOCK_SHEET_INITIAL_ROWS, columnCount: BLOCK_SHEET_INITIAL_COLUMNS } } },
      ],
    },
  });

  const spreadsheetId = response.result.spreadsheetId;
  return {
    spreadsheetId,
    spreadsheetUrl: response.result.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

export class GoogleSdkSheetsClient {
  constructor(private readonly spreadsheetId: string) {}

  async ensureSheetTabs(tabs: Array<{ title: string; rows: number; cols: number }>): Promise<void> {
    const spreadsheet = await gapi.client.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties.title",
    });
    const existing = new Set(
      (spreadsheet.result.sheets ?? [])
        .map((sheet) => sheet.properties?.title)
        .filter((title): title is string => Boolean(title)),
    );
    const requests = tabs
      .filter((tab) => !existing.has(tab.title))
      .map((tab) => ({
        addSheet: {
          properties: {
            title: tab.title,
            gridProperties: { rowCount: tab.rows, columnCount: tab.cols },
          },
        },
      }));

    if (requests.length) {
      await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: { requests },
      });
    }
  }

  async batchGet(ranges: string[]): Promise<ValueRange[]> {
    if (!ranges.length) return [];

    const response = await gapi.client.sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges,
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    return response.result.valueRanges ?? [];
  }

  async batchUpdate(data: SheetValueUpdate[]): Promise<void> {
    if (!data.length) return;

    await gapi.client.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      resource: { valueInputOption: "RAW", data },
    });
  }

  async append(range: string, values: SheetValueUpdate["values"]): Promise<AppendResponse> {
    const response = await gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: { values },
    });

    return response.result;
  }
}
