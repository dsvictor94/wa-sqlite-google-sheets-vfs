export const GOOGLE_SHEETS_BLOCK_BYTES = 1024 as const;
export const DEFAULT_BLOCK_SHEET_NAME = "__sqlite_blocks";
export const DEFAULT_LOCK_SHEET_NAME = "__sqlite_blocks";
export const DEFAULT_BLOCKS_PER_STRIPE = 256;
export const DEFAULT_STRIPES_PER_FILE = 1024;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCK_RELEASE_DELAY_MS = 1_000;
export const DEFAULT_CACHE_BLOCKS = 128;

export const LOCK_CELL_PREFIX = "LSV1|";
export const LOCK_HEADER_RANGE = "A1:H1";
export const LOCK_STATE_CELL = "A1";
export const LOCK_STATE_ROW_INDEX = 0;
export const LOCK_STATE_COLUMN_INDEX = 0;
export const LOCK_COLUMNS = 8;
export const LOCK_INITIAL_ROWS = 1000;

export const BLOCK_METADATA_START_ROW = 2;
export const BLOCK_DATA_START_ROW = 6;
export const BLOCK_SHEET_INITIAL_ROWS = BLOCK_DATA_START_ROW - 1 + 4 * DEFAULT_STRIPES_PER_FILE;
export const BLOCK_SHEET_INITIAL_COLUMNS = 2 + DEFAULT_BLOCKS_PER_STRIPE;

export const enum PersistentFileSlot {
  Main = 0,
  Journal = 1,
  Wal = 2,
  SuperJournal = 3,
}

export const PERSISTENT_FILE_SLOTS = [
  PersistentFileSlot.Main,
  PersistentFileSlot.Journal,
  PersistentFileSlot.Wal,
  PersistentFileSlot.SuperJournal,
] as const;
