# wa-sqlite-google-sheets-vfs

SQLite storage on Google Sheets, powered by a custom wa-sqlite VFS.

This package is a browser-oriented async VFS for `wa-sqlite`. It uses the Google JavaScript SDK and Google Identity Services, then stores SQLite file data as base64-encoded 1024-byte blocks in a Google Sheets tab.

## Features

- Browser-only Google auth helper.
- Google Sheets SDK client wrapper.
- Async wa-sqlite VFS implementation.
- Full read/write/truncate/sync/file-size support.
- Coarse-grained lock lease in a separate sheet tab.
- Lazy block reads: it never downloads the full database.
- In-memory handling for temporary SQLite files.

## Storage layout

The default lock tab is `__sqlite_lock`.

The default block tab is `__sqlite_blocks`. Rows 2-5 store file metadata. Block data starts at row 6. Each cell stores one base64-encoded 1024-byte block.

## Usage notes

Use rollback journal mode:

```sql
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
```

Do not use WAL unless shared-memory semantics are added to the VFS.

## Browser usage

```ts
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import {
  GoogleBrowserAuth,
  GoogleSheetsSQLiteVFS,
  ensureGoogleSheetsVfsTabs,
} from "wa-sqlite-google-sheets-vfs";

const auth = new GoogleBrowserAuth({
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY,
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
});

await auth.init();
await auth.authorize();

const spreadsheetId = "<spreadsheet-id>";
await ensureGoogleSheetsVfsTabs(spreadsheetId);

const module = await SQLiteESMFactory();
const sqlite3 = SQLite.Factory(module);

const vfs = await GoogleSheetsSQLiteVFS.create("google-sheets", module, {
  spreadsheetId,
  databaseId: "main-db",
});

sqlite3.vfs_register(vfs, true);

const db = await sqlite3.open_v2(
  "/main.db",
  SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
  "google-sheets",
);

await sqlite3.exec(db, `
  PRAGMA journal_mode=DELETE;
  PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
```
