# wa-sqlite-google-sheets-vfs

SQLite storage on Google Sheets, powered by a custom wa-sqlite VFS.

This package is a browser-oriented async VFS for `wa-sqlite`. It uses the Google JavaScript SDK and Google Identity Services, then stores SQLite file data as base64-encoded 1024-byte blocks in a Google Sheets tab.

## Demo

This repo is also a GitHub Pages demo app. The public demo intentionally does **not** ship a Google Picker `developerKey` or a Google OAuth client ID in the bundle. Users provide credentials from their own Google Cloud project in the page, and the values are stored only in that browser's local storage.

The demo connects to Google using only this OAuth scope:

```txt
https://www.googleapis.com/auth/drive.file
```

With `drive.file`, the app can read and write only the Google Drive files the user creates with the app or explicitly selects with Google Picker. For an existing spreadsheet, use the Picker button so Google grants this app access to that specific spreadsheet. Pasting a URL or ID is only for reopening a spreadsheet that was already created or selected with this app.

Why bring your own credentials? Google Picker requires a browser API key passed as `developerKey`. API keys in frontend bundles are public, and Google Cloud treats standard API keys as project identifiers for billing and quota. To avoid charging the project owner for someone else's Picker usage, this demo makes the user supply their own credentials instead of embedding a shared key.

The Pages workflow builds on pull requests and deploys on pushes to `main`.

## Google Picker setup

To use Picker in the browser demo:

1. In Google Cloud, create or select a project.
2. Enable the Google Sheets API and the Google Picker API / Drive API entries required by Picker in that project.
3. Create an OAuth 2.0 Web client ID.
4. Add authorized JavaScript origins for where the demo runs, for example:
   - `http://localhost:5173`
   - your GitHub Pages origin
5. Create an API key and restrict it as much as possible:
   - Application restriction: your web origins only.
   - API restriction: only the Picker/Drive APIs required by Picker.
6. Open **IAM & Admin → Settings** and copy the project number. This is the Picker `appId`.
7. Paste these values into the demo page:
   - OAuth Web client ID
   - Google Cloud project number / Picker appId
   - API key / Picker developerKey

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
  .setDeveloperKey("<your-api-key>")
  .setAppId("<your-google-cloud-project-number>")
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
  clientId: "<your-oauth-web-client-id>",
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
