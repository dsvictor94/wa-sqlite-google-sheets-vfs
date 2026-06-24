export type GoogleSheetsVFSMetricDetail = Record<string, string | number | boolean | null | undefined>;

export type GoogleSheetsVFSMetricEvent = {
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: GoogleSheetsVFSMetricDetail;
};

export type GoogleSheetsVFSMetrics = {
  onEvent?: (event: GoogleSheetsVFSMetricEvent) => void;
};

export type GoogleSheetsVFSOptions = {
  spreadsheetId: string;
  blockSheetName?: string;
  lockSheetName?: string;
  databaseId?: string;
  blockBytes?: 1024;
  blocksPerStripe?: number;
  stripesPerFile?: number;
  cacheBlocks?: number;
  leaseMs?: number;
  lockTimeoutMs?: number;
  lockReleaseDelayMs?: number;
  metrics?: GoogleSheetsVFSMetrics;
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
