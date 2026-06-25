import {
  BLOCK_SHEET_INITIAL_COLUMNS,
  BLOCK_SHEET_INITIAL_ROWS,
  DEFAULT_BLOCK_SHEET_NAME,
  LOCK_CELL_PREFIX,
  LOCK_STATE_CELL,
} from "./constants.js";
import type {
  AppendResponse,
  CreatedSpreadsheet,
  GoogleSheetsVFSMetricDetail,
  GoogleSheetsVFSMetrics,
  SheetValueUpdate,
  ValueRange,
} from "./types.js";
import { quoteSheetName } from "./util.js";

type GoogleApiResponse<T> = { result: T };

type GoogleSheetProperties = {
  sheetId?: number;
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

type GridRange = {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
};

type ExtendedValue = {
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
};

type CellData = {
  userEnteredValue?: ExtendedValue;
};

type RowData = {
  values?: CellData[];
};

type UpdateCellsRequest = {
  range: GridRange;
  rows: RowData[];
  fields: string;
};

type FindReplaceRequest = {
  find: string;
  replacement: string;
  matchCase: boolean;
  matchEntireCell: boolean;
  searchByRegex: boolean;
  includeFormulas?: boolean;
  range: GridRange;
};

export type SpreadsheetRequest =
  | { addSheet: { properties: GoogleSheetProperties } }
  | { findReplace: FindReplaceRequest }
  | { updateCells: UpdateCellsRequest };

type FindReplaceResponse = {
  valuesChanged?: number;
  formulasChanged?: number;
  rowsChanged?: number;
  sheetsChanged?: number;
  occurrencesChanged?: number;
};

export type SpreadsheetBatchUpdateResult = {
  replies?: Array<{
    findReplace?: FindReplaceResponse;
  }>;
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
      resource: { requests: SpreadsheetRequest[] };
    }): Promise<GoogleApiResponse<SpreadsheetBatchUpdateResult>>;
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
        { properties: { title: DEFAULT_BLOCK_SHEET_NAME, gridProperties: { rowCount: BLOCK_SHEET_INITIAL_ROWS, columnCount: BLOCK_SHEET_INITIAL_COLUMNS } } },
      ],
    },
  });

  const spreadsheetId = response.result.spreadsheetId;
  const client = new GoogleSdkSheetsClient(spreadsheetId);
  await client.batchUpdate([
    {
      range: `${quoteSheetName(DEFAULT_BLOCK_SHEET_NAME)}!${LOCK_STATE_CELL}`,
      values: [[LOCK_CELL_PREFIX]],
    },
  ]);

  return {
    spreadsheetId,
    spreadsheetUrl: response.result.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  };
}

export class GoogleSdkSheetsClient {
  private readonly sheetIdsByTitle = new Map<string, number>();

  constructor(
    private readonly spreadsheetId: string,
    private readonly metrics?: GoogleSheetsVFSMetrics,
  ) {}

  async ensureSheetTabs(tabs: Array<{ title: string; rows: number; cols: number }>): Promise<void> {
    const spreadsheet = await this.getSpreadsheetSheets("sheets.properties(sheetId,title)");
    const existing = new Set(
      (spreadsheet.sheets ?? [])
        .map((sheet) => {
          const title = sheet.properties?.title;
          const sheetId = sheet.properties?.sheetId;
          if (title !== undefined && sheetId !== undefined) this.sheetIdsByTitle.set(title, sheetId);
          return title;
        })
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
      await this.spreadsheetBatchUpdate(requests);
      this.sheetIdsByTitle.clear();
    }
  }

  async getSheetId(title: string): Promise<number> {
    const cached = this.sheetIdsByTitle.get(title);
    if (cached !== undefined) return cached;

    const spreadsheet = await this.getSpreadsheetSheets("sheets.properties(sheetId,title)");
    for (const sheet of spreadsheet.sheets ?? []) {
      const sheetTitle = sheet.properties?.title;
      const sheetId = sheet.properties?.sheetId;
      if (sheetTitle !== undefined && sheetId !== undefined) this.sheetIdsByTitle.set(sheetTitle, sheetId);
    }

    const sheetId = this.sheetIdsByTitle.get(title);
    if (sheetId === undefined) throw new Error(`Google Sheet tab not found: ${title}`);
    return sheetId;
  }

  async spreadsheetBatchUpdate(requests: SpreadsheetRequest[]): Promise<SpreadsheetBatchUpdateResult> {
    if (!requests.length) return {};

    const response = await this.measureRequest("google.sheets.spreadsheets.batchUpdate", { requests: 1, batchRequests: requests.length }, async () => {
      return await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: { requests },
      });
    });

    return response.result;
  }

  async batchGet(ranges: string[]): Promise<ValueRange[]> {
    if (!ranges.length) return [];

    const response = await this.measureRequest("google.sheets.values.batchGet", { requests: 1, ranges: ranges.length }, async () => {
      return await gapi.client.sheets.spreadsheets.values.batchGet({
        spreadsheetId: this.spreadsheetId,
        ranges,
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
    });

    return response.result.valueRanges ?? [];
  }

  async batchUpdate(data: SheetValueUpdate[]): Promise<void> {
    if (!data.length) return;

    await this.measureRequest("google.sheets.values.batchUpdate", { requests: 1, ranges: data.length }, async () => {
      await gapi.client.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        resource: { valueInputOption: "RAW", data },
      });
    });
  }

  async append(range: string, values: SheetValueUpdate["values"]): Promise<AppendResponse> {
    const response = await this.measureRequest("google.sheets.values.append", { requests: 1, range, rows: values.length }, async () => {
      return await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        resource: { values },
      });
    });

    return response.result;
  }

  private async getSpreadsheetSheets(fields: string): Promise<SpreadsheetGetResult> {
    const spreadsheet = await this.measureRequest("google.sheets.spreadsheets.get", { requests: 1, fields }, async () => {
      return await gapi.client.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields,
      });
    });
    return spreadsheet.result;
  }

  private async measureRequest<T>(name: string, detail: GoogleSheetsVFSMetricDetail, request: () => Promise<T>): Promise<T> {
    const startedAt = nowMs();

    try {
      const result = await request();
      this.emitMetric(name, true, nowMs() - startedAt, detail);
      return result;
    } catch (error) {
      this.emitMetric(name, false, nowMs() - startedAt, detail);
      throw error;
    }
  }

  private emitMetric(name: string, ok: boolean, durationMs: number, detail: GoogleSheetsVFSMetricDetail): void {
    try {
      this.metrics?.onEvent?.({ name, ok, durationMs, detail });
    } catch {
      // Metrics must never affect Google API behavior.
    }
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
