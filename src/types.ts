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
};

export type GoogleBrowserSheetsConfig = {
  apiKey: string;
  clientId: string;
  scopes?: string;
};

export type ValueRange = {
  range?: string;
  values?: unknown[][];
};

export type AppendResponse = {
  updates?: {
    updatedRange?: string;
  };
};
