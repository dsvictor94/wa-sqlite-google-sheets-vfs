# wa-sqlite-google-sheets-vfs

SQLite storage on Google Sheets, powered by a custom `wa-sqlite` VFS.

This package is a browser-oriented async VFS for `wa-sqlite`. It uses the Google JavaScript SDK and Google Identity Services, then stores SQLite file data as base64-encoded 4096-byte blocks in a stable `Data` sheet while lock/control state lives in a stable `Control` sheet.

## Features

- Browser-only Google auth helper.
- Google Sheets SDK client wrapper.
- Async wa-sqlite VFS implementation.
- Full read/write/truncate/sync/file-size support.
- Stable `Control` sheet for lock/control state.
- Stable `Data` sheet name for active SQLite block storage.
- Recovery barrier lock protocol for expired exclusive locks.
- Lazy block reads: it never downloads the full database.
- In-memory handling for temporary SQLite files.

## Access model

The demo uses the Drive file scope. With that scope, the app can read and write only Google Drive files the user creates with the app or explicitly selects with Google Picker. For an existing spreadsheet, use Picker so Google grants this app access to that specific spreadsheet. Pasting a URL or ID is only for reopening a spreadsheet that was already created or selected with this app.

The GitHub Pages demo expects the Google OAuth client id, Picker developer key, and Google Cloud project number to be provided at build time through the demo environment. These browser credentials are embedded in the published JavaScript bundle, which is expected for browser OAuth client ids, Picker app ids, and browser API keys. Restrict the API key in Google Cloud to the demo origin and to the APIs required by Picker.

## Package status

`wa-sqlite` is not published to npm, so this repo installs it directly from GitHub. The upstream package includes both the built `dist/*` artifacts and the VFS helper files under `src/`, which this implementation imports.

## Storage layout

The VFS uses two stable sheets:

- `Control` stores lock/control state in `Control!A1` and must keep fixed sheet id `100000`.
- `Data` stores SQLite metadata and base64 block data. The first `Data` sheet id is `100001`.

`Control` is never duplicated or deleted. The `Data` sheet name stays `Data`; recovery changes its underlying `sheetId` by duplicating the old sheet, deleting the old sheet id, and renaming the duplicate back to `Data`.

`Control!A1` uses the `LSV2|` prefix and includes the active data sheet id:

```txt
LSV2|D:<activeDataSheetId>|S:<expiresAtSec>:<owner>;R:<expiresAtSec>:<owner>;P:<expiresAtSec>:<owner>;X:<expiresAtSec>:<owner>;
```

A `B:<expiresAtSec>:<owner>;` entry is a recovery barrier. It blocks normal lock acquisition like `X`. The active data `sheetId` is the epoch, so no separate epoch field is stored.

Rows 2-5 in `Data` store file metadata. Block data starts at row 6. Each data cell stores one base64-encoded 4096-byte block.

## Lock recovery

Every lock acquire first removes expired `S`, `R`, and `P` entries only. It never directly cleans expired `X` entries. Instead, it uses a single recovery barrier find-and-replace that can claim either an expired `X` or an expired `B`:

```txt
expired X -> B
expired B -> B
```

The `B` entry is a recovery reservation, not the final write fence. It blocks normal lock acquisition while recovery is in progress and records which client is currently attempting recovery.

After acquiring `B`, the recovery owner performs one `spreadsheets.batchUpdate` that duplicates the old `Data` sheet to `oldDataSheetId + 1`, deletes the old sheet id, renames the duplicate back to `Data`, and updates `Control!A1` to publish the originally requested lock on the new active data sheet id. The old sheet id is the single-use recovery fence: if two clients race the recovery move, at most one batch can succeed because the old sheet id can only be deleted once.

A stale exclusive writer may still send a persistent write batch after another client has claimed `B` but before recovery duplicates the old sheet. That is allowed. Persistent writes are emitted as a single `spreadsheets.batchUpdate`, so recovery either snapshots the whole transaction or none of it. If the stale write batch reaches Sheets after recovery has deleted the old sheet id, the batch fails because it targets a deleted sheet id.

Reads address the stable `Data` sheet name, but each persistent cache miss also verifies that `Control!A1` still contains the current owner token. Block reads request `Control!A1` and the target `Data` range in the same `values.batchGet` when reading from Sheets.

Writes use the active data `sheetId` returned by lock acquisition. Persistent flushes are emitted as a single `spreadsheets.batchUpdate`, so recovery cannot snapshot a partial flush. If the flush batch succeeds but the leading lock-renewal find-and-replace changed zero occurrences, the write is still treated as durable because the data updates in the same successful batch were applied. The VFS then clears its local lease state and persistent block caches before the next operation reacquires.

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

Unlock does not flush pending main database changes; durable main database state is flushed by `xSync` outside an atomic write or by `SQLITE_FCNTL_COMMIT_ATOMIC_WRITE` during an atomic commit.

## Browser usage

The usual setup flow is:

1. Initialize and authorize Google auth in the browser.
2. Create or select a Google spreadsheet that the app is allowed to access.
3. Call `ensureGoogleSheetsVfsTabs(spreadsheetId)`.
4. Create a `GoogleSheetsSQLiteVFS` instance for that spreadsheet.
5. Register the VFS with `wa-sqlite` and open the database with this VFS name.

Use rollback journal mode and `synchronous=FULL` for durable commits.
