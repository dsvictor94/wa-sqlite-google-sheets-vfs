# wa-sqlite-google-sheets-vfs

SQLite storage on Google Sheets, powered by a custom wa-sqlite VFS.

This package is a browser-oriented async VFS for `wa-sqlite`. It uses the Google JavaScript SDK and Google Identity Services, then stores SQLite file data as base64-encoded 1024-byte blocks in a Google Sheets tab.

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

Rows 2-5 store file metadata. Block data starts at row 6. Each data cell stores one base64-encoded 1024-byte block.

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

## Operation breakdown

This section names every Google Sheets API method the VFS layer can call through `GoogleSdkSheetsClient`. Counts below are network request counts, not the number of subrequests inside a batch.

| Operation path | Google Sheets API calls | Notes |
| --- | --- | --- |
| `createGoogleSheetsVfsSpreadsheet()` | `spreadsheets.create` + `spreadsheets.values.batchUpdate` | Creates a spreadsheet with the default block tab, then initializes the lock cell to `LSV1|`. |
| `ensureGoogleSheetsVfsTabs()` | `spreadsheets.get`, optional `spreadsheets.batchUpdate`, `spreadsheets.values.batchGet`, optional `spreadsheets.values.batchUpdate` | Reads existing tabs, creates the block tab if missing, reads the lock cell, and initializes it if it is missing or invalid. |
| `GoogleSheetsSQLiteVFS.create()` / first VFS use | No direct call in the constructor. The first operation that needs Sheets calls `prepareForUse()` and then the operation-specific calls below. | `GoogleSdkSheetsClient` is lazy except where setup helpers are called. |
| `jOpen` for temporary files | None | Temp files are kept in memory. |
| `jOpen` for an existing persistent file | `spreadsheets.values.batchGet` | Reads the slot metadata row to discover file size. |
| `jOpen` with `SQLITE_OPEN_CREATE` when metadata is missing | `spreadsheets.values.batchGet`, then lock acquisition calls, then `spreadsheets.values.batchUpdate` | Reads metadata, acquires an exclusive lease, and writes an empty metadata row. Lock acquisition can call `spreadsheets.get` if the sheet id is not cached and always calls `spreadsheets.batchUpdate` per attempt. |
| `jRead` satisfied by dirty/cache/temp/zero block | None | Dirty, cached, temp, and beyond-EOF reads avoid Sheets. |
| `jRead` of an uncached persistent block | `spreadsheets.values.batchGet` | Reads exactly the touched block cell; multi-block SQLite reads currently issue one block read per uncached block. |
| `jWrite` full block append/overwrite | Lock acquisition calls only | Marks dirty blocks in memory. The persistent Sheets write is deferred to `jSync` or atomic commit. |
| `jWrite` partial overwrite of an existing persistent block | Lock acquisition calls + `spreadsheets.values.batchGet` for each uncached partial block | Partial writes must read the visible block first so unchanged bytes can be preserved. |
| `jTruncate` | Lock acquisition calls only | Marks size and dirty state in memory; metadata is persisted on flush. |
| `jSync` with no dirty blocks and no dirty size | None after local checks | No-op flush does not hit Sheets. |
| `jSync` for persistent dirty data | optional `spreadsheets.get`, `spreadsheets.batchUpdate` | Ensures/renews an exclusive lease and writes dirty block cells plus metadata in one `spreadsheets.batchUpdate`. The same batch can include the lock renewal `findReplace` request. |
| `jClose` | Same as `jSync`, then optional unlock calls | Close flushes dirty state, removes the file handle, and releases the lease when no persistent files remain. |
| `jFileSize`, `jSectorSize`, `jDeviceCharacteristics`, `jGetLastError` | None | These are local VFS responses. |
| `jLock` | optional `spreadsheets.get`, `spreadsheets.batchUpdate` per attempt | Uses `findReplace` requests to clean expired leases and acquire the target SQLite rollback lock. Exclusive lock acquisition uses pending-then-exclusive subrequests in the same batch. |
| `jUnlock(SQLITE_LOCK_NONE)` | Deferred `spreadsheets.batchUpdate` | Schedules lease release; the release removes this owner from the lock cell and cleans expired leases. If `lockReleaseDelayMs` is `0`, this happens immediately. |
| `jUnlock(SQLITE_LOCK_SHARED)` | optional `spreadsheets.get`, `spreadsheets.batchUpdate` | Downgrades this owner's durable lock entry to shared and cleans expired leases. |
| `jAccess` for temporary or unsupported paths | None | Non-persistent paths return not found without Sheets. |
| `jAccess` for persistent paths | `spreadsheets.values.batchGet` | Reads the metadata row for the mapped persistent slot. |
| `jDelete` for temporary or unsupported paths | None | Non-persistent paths are treated as already absent. |
| `jDelete` for persistent paths | Lock acquisition calls + `spreadsheets.values.batchUpdate` | Acquires exclusive lease, clears the metadata size cell, and clears open volatile state for that slot. |
| `jCheckReservedLock` when this handle already has reserved-or-higher lock | None | Uses local lease state. |
| `jCheckReservedLock` otherwise | optional `spreadsheets.get`, `spreadsheets.batchUpdate` | Cleans expired leases, probes for any reserved/pending/exclusive entry with a regex `findReplace`, then restores the probe marker in the same batch. |
| `SQLITE_FCNTL_BEGIN_ATOMIC_WRITE` | Lock acquisition calls | Acquires exclusive lease and marks the main file as being in atomic write mode. |
| `SQLITE_FCNTL_COMMIT_ATOMIC_WRITE` | optional `spreadsheets.get`, `spreadsheets.batchUpdate` | Flushes dirty blocks and metadata through one batch, optionally prepending an exclusive lease renewal request. |
| `SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE` | None | Discards in-memory atomic-write state. |
| `GoogleSdkSheetsClient.append()` | `spreadsheets.values.append` | Exposed by the client wrapper but not used by the current VFS read/write/lock paths. |

### Lock API call details

Lock acquisition and renewal are intentionally expressed as Sheets `spreadsheets.batchUpdate` calls using `findReplace` subrequests against the lock cell, rather than `values.get` followed by `values.update`. This keeps each lock attempt to a single conditional network write after the sheet id is known.

| Lock helper path | Batch subrequests |
| --- | --- |
| Acquire shared/reserved/pending | `cleanupExpiredRequest` + one regex `findReplace` for the target lock. |
| Acquire exclusive | `cleanupExpiredRequest` + one regex `findReplace` to become pending + one regex `findReplace` to become exclusive if this owner is the only pending entry. |
| Renew current lock | `cleanupExpiredRequest` + one exact `findReplace` from the old lease expiration to the new expiration. |
| Release to none | One regex `findReplace` removing this owner's entry + `cleanupExpiredRequest`. |
| Downgrade to shared | One exact `findReplace` from the current entry to `S` + `cleanupExpiredRequest`. |
| Check reserved lock | `cleanupExpiredRequest` + regex probe for `[RPX]` + exact cleanup of the temporary probe marker. |
| Write-batch exclusive renewal | One regex `findReplace` prepended to the dirty block/metadata `updateCells` requests. |

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