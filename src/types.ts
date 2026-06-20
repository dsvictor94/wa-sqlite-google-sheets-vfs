export type GoogleSheetsVFSOptions = {
  spreadsheetId: string;
  lockSheetName?: string;
  blockSheetName?: string;
  databaseId?: string;
  blockBytes?: 1024;
  blocksPerStripe?: number;
  stripesPerFile?: number;
  cacheBlocks?: number;
  leaseMs?: number;
  lockTimeoutMs?: number;
  lockReleaseDelayMs?: number;
};

export type GoogleBrowserSheetsConfig = {
  apiKey?: string;
  clientId: string;
  scopes?: string;
};

export type CreatedSpreadsheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
};

export type SheetCellValue = string | number | boolean | null;
export type SheetRow = SheetCellValue[];

export type ValueRange = {
  range?: string;
  values?: unknown[][];
};

export type SheetValueUpdate = {
  range: string;
  values: SheetRow[];
};

export type AppendResponse = {
  updates?: {
    updatedRange?: string;
  };
};
