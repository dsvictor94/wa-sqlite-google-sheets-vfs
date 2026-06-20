declare module "wa-sqlite/src/FacadeVFS.js" {
  export class FacadeVFS {
    constructor(name: string, module: unknown);
    isReady(): Promise<void>;
  }
}

declare module "wa-sqlite/src/VFS.js" {
  export const SQLITE_OK: number;
  export const SQLITE_BUSY: number;
  export const SQLITE_CANTOPEN: number;
  export const SQLITE_IOERR_CLOSE: number;
  export const SQLITE_IOERR_READ: number;
  export const SQLITE_IOERR_WRITE: number;
  export const SQLITE_IOERR_TRUNCATE: number;
  export const SQLITE_IOERR_FSYNC: number;
  export const SQLITE_IOERR_FSTAT: number;
  export const SQLITE_IOERR_LOCK: number;
  export const SQLITE_IOERR_UNLOCK: number;
  export const SQLITE_IOERR_SHORT_READ: number;
  export const SQLITE_IOERR_ACCESS: number;
  export const SQLITE_IOERR_DELETE: number;
  export const SQLITE_IOERR_CHECKRESERVEDLOCK: number;
  export const SQLITE_OPEN_CREATE: number;
  export const SQLITE_OPEN_MAIN_DB: number;
  export const SQLITE_OPEN_MAIN_JOURNAL: number;
  export const SQLITE_OPEN_SUPER_JOURNAL: number;
  export const SQLITE_OPEN_WAL: number;
  export const SQLITE_LOCK_NONE: number;
}

declare module "wa-sqlite" {
  export const SQLITE_OPEN_CREATE: number;
  export const SQLITE_OPEN_READWRITE: number;
  export function Factory(module: unknown): any;
}

declare module "wa-sqlite/dist/wa-sqlite-async.mjs" {
  const SQLiteESMFactory: (moduleOptions?: Record<string, unknown>) => Promise<unknown>;
  export default SQLiteESMFactory;
}
