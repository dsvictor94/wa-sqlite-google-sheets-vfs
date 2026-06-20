# wa-sqlite-google-sheets-vfs

SQLite storage on Google Sheets, powered by a custom wa-sqlite VFS.

This package is a browser-oriented async VFS for `wa-sqlite`. It uses the Google JavaScript SDK and Google Identity Services, then stores SQLite file data as base64-encoded 1024-byte blocks in a Google Sheets tab.

## Demo

This repo is also a GitHub Pages demo app. The demo connects to Google in the browser, lets you create a fresh spreadsheet or open an existing spreadsheet URL/ID, and provides a responsive SQL editor for running arbitrary SQLite statements through the Google Sheets VFS.

If you set `VITE_GOOGLE_API_KEY` for the demo build, the app also enables Google Drive Picker so users can select an existing spreadsheet from Drive. Without that key, users can still create a new spreadsheet or paste an existing spreadsheet URL/ID.

The Pages workflow builds on pull requests and deploys on pushes to `main`.

## Package status

`wa-sqlite` is not published to npm, so this repo installs it directly from GitHub:

```json
{
  "dependencies": {
    "wa-sqlite": "github:rhashimoto/wa-sqlite#master"
  }
}
```

The upstream package includes both the built `dist/*` artifacts and the VFS helper files under `src/`, which this implementation imports.

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
