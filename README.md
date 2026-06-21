# wa-sqlite-google-sheets-vfs

SQLite storage on Google Sheets, powered by a custom wa-sqlite VFS.

This package is a browser-oriented async VFS for `wa-sqlite`. It uses the Google JavaScript SDK and Google Identity Services, then stores SQLite file data as base64-encoded 1024-byte blocks in a Google Sheets tab.

## Demo

This repo is also a GitHub Pages demo app. The demo connects to Google in the browser using only this OAuth scope:

```txt
https://www.googleapis.com/auth/drive.file
```

With `drive.file`, the app can read and write only the Google Drive files the user creates with the app or explicitly selects with Google Picker. For an existing spreadsheet, use the Picker button so Google grants this app access to that specific spreadsheet. Pasting a URL or ID is only for reopening a spreadsheet that was already created or selected with this app.

If you set `VITE_GOOGLE_API_KEY` for the demo build, the app enables Google Picker so users can select an existing spreadsheet from Drive. Without that key, users can still create a new spreadsheet or reopen a spreadsheet the app already has access to.

The Pages workflow builds on pull requests and deploys on pushes to `main`.

## Google Picker setup

To enable Picker in the browser demo:

1. In Google Cloud, use the same project for all credentials.
2. Enable the Google Sheets API.
3. Create an OAuth 2.0 Web client ID and add your local/demo origins, for example `http://localhost:5173` and your GitHub Pages origin.
4. Create an API key and restrict it to your web origins.
5. Configure the OAuth consent screen with only `https://www.googleapis.com/auth/drive.file`.
6. Set the demo environment variable:

```bash
VITE_GOOGLE_API_KEY="<your-api-key>"
```

The demo already uses the OAuth client ID in `demo/main.ts`. If you fork this project, replace `GOOGLE_CLIENT_ID` with your own Web client ID. Picker also needs the Google Cloud project number as its app ID; the demo derives it from the client ID prefix.

The core Picker flow is:

```ts
const token = gapi.client.getToken()?.access_token;

const view = new google.picker.DocsView(
  google.picker.ViewId.SPREADSHEETS ?? google.picker.ViewId.DOCS,
)
  .setMimeTypes("application/vnd.google-apps.spreadsheet")
  .setSelectFolderEnabled(false);

new google.picker.PickerBuilder()
  .addView(view)
  .setDeveloperKey(import.meta.env.VITE_GOOGLE_API_KEY)
  .setAppId("<google-cloud-project-number>")
  .setOAuthToken(token)
  .setCallback((data) => {
    if (data[google.picker.Response.ACTION] !== google.picker.Action.PICKED) return;

    const selected = data[google.picker.Response.DOCUMENTS][0];
    const spreadsheetId = selected[google.picker.Document.ID];
    // Use spreadsheetId with the Sheets API.
  })
  .build()
  .setVisible(true);
```

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
  DRIVE_FILE_SCOPE,
  GoogleBrowserAuth,
  GoogleSheetsSQLiteVFS,
  ensureGoogleSheetsVfsTabs,
} from "wa-sqlite-google-sheets-vfs";

const auth = new GoogleBrowserAuth({
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY,
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  scopes: DRIVE_FILE_SCOPE,
});

await auth.init();
await auth.authorize();

const spreadsheetId = "<spreadsheet-id-selected-with-picker-or-created-by-this-app>";
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
