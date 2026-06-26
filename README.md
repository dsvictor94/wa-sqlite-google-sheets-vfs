# wa-sqlite-google-sheets-vfs

SQLite storage on Google Sheets, powered by a custom wa-sqlite VFS.

This package is a browser-oriented async VFS for `wa-sqlite`. It uses the Google JavaScript SDK and Google Identity Services, then stores SQLite file data as base64-encoded 4096-byte blocks in a Google Sheets tab.

## Demo

This repo is also a GitHub Pages demo app. The demo credentials are configured at build time through required Vite environment variables, so forks can replace the Google Cloud project without editing TypeScript source code.

The demo connects to Google using only this OAuth scope:

```txt
https://www.googleapis.com/auth/drive.file
```

With `drive.file`, the app can read and write only the Google Drive files the user creates with the app or explicitly selects with Google Picker. For an existing spreadsheet, use the Picker button so Google grants this app access to that specific spreadsheet. Pasting a URL or ID is only for reopening a spreadsheet that was already created or selected with this app.

The Pages workflow builds on pull requests and deploys on pushes to `main`.

## Demo configuration

Set these required variables before building the demo:

```bash
VITE_GOOGLE_CLIENT_ID="<oauth-web-client-id>"
VITE_GOOGLE_API_KEY="<picker-developer-key>"
VITE_GOOGLE_APP_ID="<google-cloud-project-number>"
```

The demo fails during startup if any of these variables are missing.

`VITE_GOOGLE_APP_ID` is the Google Cloud project number used by Google Picker. It is required and must be set explicitly. Do not use the Google Cloud project ID string.

For local development, create `demo/.env.local` or pass the variables in your shell before running Vite. For GitHub Pages, set repository variables under **Settings → Secrets and variables → Actions → Variables**:

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GOOGLE_API_KEY`
- `VITE_GOOGLE_APP_ID`

The workflow passes those variables into the Vite build. They are embedded in the published JavaScript bundle, which is expected for browser OAuth client IDs, Picker app IDs, and browser API keys. Restrict the API key in Google Cloud to the GitHub Pages origin and only the APIs needed by Picker.

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
7. Set the three `VITE_GOOGLE_*` variables above.

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
  .setAppId(import.meta.env.VITE_GOOGLE_APP_ID)
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
- Rollback-style lock state stored in the database sheet lock cell.
- Lazy block reads: it never downloads the full database.
- In-memory handling for temporary SQLite files.

## Storage layout

The default block tab is `__sqlite_blocks`.

Cell `A1` is reserved for lock state. New lock state uses the `LSV1|` prefix followed by zero or more entries in this form:

```txt
S:<expiresAtSec>:<owner>;
R:<expiresAtSec>:<owner>;
P:<expiresAtSec>:<owner>;
X:<expiresAtSec>:<owner>;
```

Rows 2-5 store file metadata. Block data starts at row 6. Each data cell stores one base64-encoded 4096-byte block.

## Usage notes

For durable commits, use rollback journal mode with synchronous `FULL` or `EXTRA`:

```sql
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
```

`EXTRA` is also acceptable, but it is not expected to add meaningful protection for this Sheets-backed VFS because there is no filesystem directory to sync after deleting the rollback journal.

The VFS advertises SQLite batch-atomic write support for the main database file. Rollback journals and other auxiliary SQLite files are kept in memory; only main database blocks and metadata are persisted to Google Sheets. During an atomic commit, dirty main database blocks and metadata are flushed together with a single Sheets `spreadsheets.batchUpdate` request.

A SQL transaction that commits successfully is expected to be durable once SQLite completes the batch-atomic commit path and the Sheets batch update returns successfully. Do not use `synchronous=NORMAL` or `synchronous=OFF` if your application requires a successful SQL `COMMIT` to be durable after a browser reload, tab close, network failure, or process crash.

Do not use WAL unless shared-memory semantics are added to the VFS. This VFS keeps WAL files in memory and rejects attempts to open SQLite WAL files.

For multi-statement writes, prefer an explicit transaction so SQLite does not perform a full lock/unlock cycle for every individual statement:

```sql
BEGIN IMMEDIATE;
-- related writes
COMMIT;
```

The lock helper stores one entry per open handle and uses SQLite rollback-style states: shared (`S`), reserved (`R`), pending (`P`), and exclusive (`X`). Each lock acquisition first removes expired entries in the same Sheets `spreadsheets.batchUpdate` call, and exclusive flushes can prepend a lease renewal request to the same batch as the block writes.

Unlock does not flush pending main database changes; durable main database state is flushed by `xSync` outside an atomic write or by `SQLITE_FCNTL_COMMIT_ATOMIC_WRITE` during an atomic commit.

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
