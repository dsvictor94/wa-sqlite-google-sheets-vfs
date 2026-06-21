import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { DRIVE_FILE_SCOPE, GoogleBrowserAuth, GoogleSheetsSQLiteVFS, createGoogleSheetsVfsSpreadsheet, ensureGoogleSheetsVfsTabs } from "../dist/index.js";

declare const gapi: any;
declare const google: any;

type LogLevel = "info" | "ok" | "error";
type ActiveDatabase = { db: unknown; spreadsheetId: string; spreadsheetUrl: string };
type ResultSet = { columns: string[]; rows: Array<Record<string, unknown>> };

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {});
const GOOGLE_CLIENT_ID = env.VITE_GOOGLE_CLIENT_ID ?? "";
const GOOGLE_API_KEY = env.VITE_GOOGLE_API_KEY ?? "";
const GOOGLE_APP_ID = env.VITE_GOOGLE_APP_ID ?? "";
const DB_PATH = "/demo.db";
const DB_ID = "sql-editor-demo";
const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

const DEFAULT_SQL = `-- Run any SQLite statement supported by wa-sqlite.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO notes(message) VALUES ('Hello from the Google Sheets VFS');

SELECT id, message, created_at
FROM notes
ORDER BY id DESC
LIMIT 10;`;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app element");

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">wa-sqlite + Google Sheets VFS</p>
      <h1>SQLite backed by your Google spreadsheet.</h1>
      <p class="lede">Create a spreadsheet, or select one with Google Picker, then run SQL against the VFS from a browser-only demo.</p>
    </section>

    <section class="card split">
      <div><h2>1. Connect Google</h2><p>Authorize per-file Google Drive access. SQLite blocks are stored only in the spreadsheet you create or choose.</p><p id="config-hint" class="hint"></p></div>
      <button id="connect" type="button">Connect Google</button>
    </section>

    <section class="card">
      <h2>2. Choose storage</h2>
      <div class="actions">
        <button id="create-spreadsheet" type="button">Create new spreadsheet</button>
        <button id="pick-spreadsheet" type="button">Select from Drive</button>
      </div>
      <p id="picker-hint" class="hint"></p>
      <form id="open-existing" class="spreadsheet-form">
        <label for="spreadsheet-input">Or reopen a spreadsheet URL / ID already created or selected with this app</label>
        <div class="input-row">
          <input id="spreadsheet-input" type="text" inputmode="url" autocomplete="off" placeholder="https://docs.google.com/spreadsheets/d/..." />
          <button type="submit">Open</button>
        </div>
      </form>
      <div id="database-status" class="database-status" aria-live="polite"></div>
    </section>

    <section class="card">
      <div class="split editor-heading">
        <div><h2>3. SQL editor</h2><p>Use <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> on desktop, or the run button on mobile.</p></div>
        <div class="actions editor-actions">
          <button id="reset-sql" type="button" class="secondary">Reset</button>
          <button id="clear-results" type="button" class="secondary">Clear</button>
          <button id="run-sql" type="button">Run SQL</button>
        </div>
      </div>
      <textarea id="sql-editor" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
    </section>

    <section id="query-results" class="card result" hidden></section>
    <section class="card"><h2>Status</h2><ol id="log" class="log"></ol></section>
  </main>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const configHint = $<HTMLParagraphElement>("#config-hint");
const connectButton = $<HTMLButtonElement>("#connect");
const createButton = $<HTMLButtonElement>("#create-spreadsheet");
const pickButton = $<HTMLButtonElement>("#pick-spreadsheet");
const pickerHint = $<HTMLParagraphElement>("#picker-hint");
const openForm = $<HTMLFormElement>("#open-existing");
const spreadsheetInput = $<HTMLInputElement>("#spreadsheet-input");
const databaseStatus = $<HTMLDivElement>("#database-status");
const sqlEditor = $<HTMLTextAreaElement>("#sql-editor");
const runButton = $<HTMLButtonElement>("#run-sql");
const resetButton = $<HTMLButtonElement>("#reset-sql");
const clearButton = $<HTMLButtonElement>("#clear-results");
const results = $<HTMLElement>("#query-results");
const logList = $<HTMLOListElement>("#log");

let auth: GoogleBrowserAuth | undefined;
let sqliteModule: unknown;
let sqlite3: any;
let db: ActiveDatabase | undefined;
let busy = false;

sqlEditor.value = DEFAULT_SQL;
updateConfigHint();
renderDatabaseStatus();
updateControls();

connectButton.addEventListener("click", () => runTask(async () => {
  await connectGoogle(true);
  log("Google per-file access ready", "ok");
}));

createButton.addEventListener("click", () => runTask(async () => {
  await connectGoogle();
  log("Creating a new spreadsheet in your Drive", "info");
  const spreadsheet = await createGoogleSheetsVfsSpreadsheet(`wa-sqlite SQL editor ${new Date().toISOString()}`);
  await openSpreadsheet(spreadsheet.spreadsheetId, spreadsheet.spreadsheetUrl);
}));

pickButton.addEventListener("click", () => runTask(async () => {
  await connectGoogle();
  const spreadsheet = await pickSpreadsheet();
  if (!spreadsheet) return log("Spreadsheet selection canceled", "info");
  await openSpreadsheet(spreadsheet.spreadsheetId, spreadsheet.spreadsheetUrl);
}));

openForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runTask(async () => {
    await connectGoogle();
    const spreadsheetId = extractSpreadsheetId(spreadsheetInput.value);
    if (!spreadsheetId) throw new Error("Paste a valid Google Sheets URL or spreadsheet ID.");
    await openSpreadsheet(spreadsheetId, spreadsheetUrl(spreadsheetId));
  });
});

runButton.addEventListener("click", () => runTask(runSql));
resetButton.addEventListener("click", () => { sqlEditor.value = DEFAULT_SQL; sqlEditor.focus(); });
clearButton.addEventListener("click", () => { results.hidden = true; results.innerHTML = ""; });
sqlEditor.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void runTask(runSql);
  }
});

async function runTask(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  updateControls();
  try {
    await task();
  } catch (error) {
    const message = formatError(error);
    log(message, "error");
    renderError(message);
    console.error(error);
  } finally {
    busy = false;
    updateControls();
  }
}

async function connectGoogle(forceConsent = false): Promise<void> {
  if (!GOOGLE_CLIENT_ID) throw new Error("Set VITE_GOOGLE_CLIENT_ID before building the demo.");

  if (!auth) {
    log("Loading Google SDK", "info");
    auth = new GoogleBrowserAuth({ clientId: GOOGLE_CLIENT_ID, scopes: DRIVE_FILE_SCOPE });
    await auth.init();
  }
  if (forceConsent || !accessToken()) {
    log("Requesting per-file Google Drive access", "info");
    await auth.authorize(forceConsent ? "consent" : "");
  }
  connectButton.textContent = "Google connected";
}

async function openSpreadsheet(spreadsheetId: string, spreadsheetLink: string): Promise<void> {
  log(`Preparing spreadsheet ${spreadsheetId}`, "info");
  await ensureGoogleSheetsVfsTabs(spreadsheetId);
  log("VFS tabs are ready", "ok");

  if (db && sqlite3) await sqlite3.close(db.db);
  const { module, sqlite } = await loadSqlite();
  const vfsName = `google-sheets-${Date.now().toString(36)}`;
  const vfs = await GoogleSheetsSQLiteVFS.create(vfsName, module, { spreadsheetId, databaseId: DB_ID, lockTimeoutMs: 15_000 });
  sqlite.vfs_register(vfs, true);

  log("Opening SQLite database through the VFS", "info");
  db = {
    db: await sqlite.open_v2(DB_PATH, SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE, vfsName),
    spreadsheetId,
    spreadsheetUrl: spreadsheetLink,
  };
  spreadsheetInput.value = spreadsheetId;
  await sqlite.exec(db.db, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
  log("SQLite database ready", "ok");
  renderDatabaseStatus();
  results.hidden = false;
  results.innerHTML = `<h2>Ready</h2><p>The editor is connected to <code>${escapeHtml(DB_PATH)}</code> with database ID <code>${escapeHtml(DB_ID)}</code>.</p>`;
}

async function loadSqlite(): Promise<{ module: unknown; sqlite: any }> {
  if (!sqliteModule || !sqlite3) {
    log("Loading wa-sqlite async build", "info");
    sqliteModule = await SQLiteESMFactory({ locateFile: (file: string) => file.endsWith(".wasm") ? wasmUrl : file });
    sqlite3 = SQLite.Factory(sqliteModule as never);
  }
  return { module: sqliteModule, sqlite: sqlite3 };
}

async function runSql(): Promise<void> {
  if (!db) throw new Error("Choose or create a spreadsheet before running SQL.");
  const sql = sqlEditor.value.trim();
  if (!sql) throw new Error("Write a SQL statement before running it.");

  const resultSets: ResultSet[] = [];
  let active: ResultSet | undefined;
  let activeKey = "";
  const startedAt = performance.now();
  log("Running SQL", "info");

  await sqlite3.exec(db.db, sql, (row: unknown[], columns: string[]) => {
    const names = columns.map(String);
    const key = names.join("\u001f");
    if (!active || activeKey !== key) {
      active = { columns: names, rows: [] };
      activeKey = key;
      resultSets.push(active);
    }
    active.rows.push(Object.fromEntries(names.map((name, index) => [name, row[index]])));
  });

  const durationMs = performance.now() - startedAt;
  log(`SQL executed in ${formatDuration(durationMs)}`, "ok");
  renderResults(resultSets, durationMs);
}

async function pickSpreadsheet(): Promise<{ spreadsheetId: string; spreadsheetUrl: string } | undefined> {
  if (!GOOGLE_API_KEY) throw new Error("Set VITE_GOOGLE_API_KEY before building the demo.");
  if (!GOOGLE_APP_ID) throw new Error("Set VITE_GOOGLE_APP_ID to the Google Cloud project number before building the demo.");
  const token = accessToken();
  if (!token) throw new Error("Google access token is missing. Connect Google first.");
  if (!(globalThis as any).google?.picker) await new Promise<void>((resolve) => gapi.load("picker", resolve));

  return new Promise((resolve, reject) => {
    const picker = google.picker;
    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS ?? picker.ViewId.DOCS)
      .setMimeTypes(SPREADSHEET_MIME_TYPE)
      .setSelectFolderEnabled(false);
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setAppId(GOOGLE_APP_ID)
      .setDeveloperKey(GOOGLE_API_KEY)
      .setOAuthToken(token)
      .setCallback((data: any) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.CANCEL) return resolve(undefined);
        if (action !== picker.Action.PICKED) return;
        const selected = data[picker.Response.DOCUMENTS]?.[0];
        const spreadsheetId = selected?.[picker.Document.ID];
        if (!spreadsheetId) return reject(new Error("Google Picker did not return a spreadsheet ID."));
        resolve({ spreadsheetId, spreadsheetUrl: selected?.[picker.Document.URL] ?? spreadsheetUrl(spreadsheetId) });
      })
      .build()
      .setVisible(true);
  });
}

function accessToken(): string | undefined {
  try { return gapi.client.getToken?.()?.access_token; } catch { return undefined; }
}

function extractSpreadsheetId(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? trimmed.match(/^[a-zA-Z0-9_-]{20,}$/)?.[0];
}

function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

function updateConfigHint(): void {
  if (!GOOGLE_CLIENT_ID) {
    configHint.textContent = "Demo is missing VITE_GOOGLE_CLIENT_ID. Set it in .env.local or GitHub Actions variables before building.";
  } else if (!GOOGLE_API_KEY) {
    configHint.textContent = "OAuth is configured. Picker is disabled until VITE_GOOGLE_API_KEY is set.";
  } else if (!GOOGLE_APP_ID) {
    configHint.textContent = "Picker is disabled until VITE_GOOGLE_APP_ID is set to the Google Cloud project number.";
  } else {
    configHint.textContent = "Google credentials are configured from build-time VITE_* variables.";
  }

  pickerHint.textContent = GOOGLE_API_KEY && GOOGLE_APP_ID
    ? "This demo requests only the drive.file scope. Picker grants access to the specific spreadsheet you choose."
    : "Picker is disabled because VITE_GOOGLE_API_KEY or VITE_GOOGLE_APP_ID was not set at build time. You can still create a new spreadsheet after connecting Google.";
}

function renderDatabaseStatus(): void {
  if (!db) {
    databaseStatus.innerHTML = `<p class="muted">No spreadsheet opened yet.</p>`;
    updateControls();
    return;
  }
  databaseStatus.innerHTML = `<p class="status-ok">Connected to spreadsheet-backed SQLite.</p><p class="spreadsheet-meta"><span>ID: <code>${escapeHtml(db.spreadsheetId)}</code></span><a href="${escapeAttr(db.spreadsheetUrl)}" target="_blank" rel="noreferrer">Open spreadsheet</a></p>`;
  updateControls();
}

function renderResults(resultSets: ResultSet[], durationMs: number): void {
  results.hidden = false;
  if (!resultSets.length) {
    results.innerHTML = `<h2>Result</h2><p class="status-ok">Query executed successfully in ${escapeHtml(formatDuration(durationMs))}. No rows were returned.</p>`;
    return;
  }
  results.innerHTML = `<h2>Result</h2><p class="muted">${resultSets.length} result set${resultSets.length === 1 ? "" : "s"} returned in ${escapeHtml(formatDuration(durationMs))}.</p>${resultSets.map(renderSet).join("")}`;
}

function renderSet(set: ResultSet, index: number): string {
  return `<section class="result-set"><h3>Result set ${index + 1} <span>${set.rows.length} row${set.rows.length === 1 ? "" : "s"}</span></h3><div class="table-wrap"><table><thead><tr>${set.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${set.rows.map((row) => `<tr>${set.columns.map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}

function renderError(message: string): void {
  results.hidden = false;
  results.innerHTML = `<h2>Error details</h2><pre>${escapeHtml(message)}</pre>`;
}

function log(message: string, level: LogLevel): void {
  const item = document.createElement("li");
  item.className = level;
  item.textContent = message;
  logList.appendChild(item);
  item.scrollIntoView({ block: "nearest" });
}

function updateControls(): void {
  connectButton.disabled = busy || !GOOGLE_CLIENT_ID;
  createButton.disabled = busy || !GOOGLE_CLIENT_ID;
  pickButton.disabled = busy || !GOOGLE_CLIENT_ID || !GOOGLE_API_KEY || !GOOGLE_APP_ID;
  spreadsheetInput.disabled = busy;
  openForm.querySelector<HTMLButtonElement>("button")!.disabled = busy || !GOOGLE_CLIENT_ID;
  runButton.disabled = busy || !db;
  resetButton.disabled = busy;
  clearButton.disabled = busy;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  const apiError = (error as { result?: { error?: { message?: string; status?: string; code?: number } } }).result?.error;
  if (apiError?.message) return `Google API error${apiError.code ? ` ${apiError.code}` : ""}${apiError.status ? ` (${apiError.status})` : ""}: ${apiError.message}`;
  try { return JSON.stringify(error, null, 2); } catch { return String(error); }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs.toFixed(0)} ms` : `${(durationMs / 1_000).toFixed(2)} s`;
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
