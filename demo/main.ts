import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { DRIVE_FILE_SCOPE, GoogleBrowserAuth, GoogleSheetsSQLiteVFS, createGoogleSheetsVfsSpreadsheet, ensureGoogleSheetsVfsTabs } from "../dist/index.js";

declare const gapi: any;
declare const google: any;

type LogLevel = "info" | "ok" | "error";
type ActiveDatabase = { db: unknown; spreadsheetId: string; spreadsheetUrl: string };
type ResultSet = { columns: string[]; rows: Array<Record<string, unknown>> };
type VfsMetricEvent = { name: string; ok: boolean; durationMs: number; detail?: Record<string, string | number | boolean | null | undefined> };
type MetricSummary = { name: string; count: number; ok: number; failed: number; totalMs: number; maxMs: number; bytes: number; blocks: number; dirtyBlocks: number };
type MetricSnapshot = { events: number; totalMs: number; operations: MetricSummary[]; blockSources: Record<string, number> };
type BenchmarkScenario = { id: string; title: string; description: string; sql: string };
type BenchmarkRun = { title: string; durationMs: number; snapshot: MetricSnapshot; at: Date };

const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {});
const GOOGLE_CLIENT_ID = requiredEnv("VITE_GOOGLE_CLIENT_ID");
const GOOGLE_API_KEY = requiredEnv("VITE_GOOGLE_API_KEY");
const GOOGLE_APP_ID = requiredEnv("VITE_GOOGLE_APP_ID");
const DB_PATH = "/demo.db";
const DB_ID = "sql-editor-demo";
const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

const DEFAULT_SQL = `-- Run any SQLite statement supported by wa-sqlite.
-- Group related writes in an explicit transaction to avoid one lock/unlock cycle per statement.
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO notes(message) VALUES ('Hello from the Google Sheets VFS');

COMMIT;

SELECT id, message, created_at
FROM notes
ORDER BY id DESC
LIMIT 10;`;

const AUTOCOMMIT_INSERTS = Array.from({ length: 10 }, (_, index) =>
  `INSERT INTO bench_notes(label, payload) VALUES ('autocommit-10', 'row-${index + 1}-' || hex(randomblob(96)));`,
).join("\n");

const BENCHMARKS: BenchmarkScenario[] = [
  {
    id: "setup",
    title: "Setup benchmark table",
    description: "Creates the benchmark table if it does not exist.",
    sql: `CREATE TABLE IF NOT EXISTS bench_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SELECT COUNT(*) AS rows FROM bench_notes;`,
  },
  {
    id: "autocommit-10",
    title: "10 autocommit inserts",
    description: "Runs ten independent INSERT statements to expose lock/unlock overhead.",
    sql: `CREATE TABLE IF NOT EXISTS bench_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
${AUTOCOMMIT_INSERTS}
SELECT COUNT(*) AS rows FROM bench_notes;`,
  },
  {
    id: "tx-100",
    title: "100 inserts in one transaction",
    description: "Writes 100 rows inside BEGIN IMMEDIATE / COMMIT.",
    sql: `CREATE TABLE IF NOT EXISTS bench_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
BEGIN IMMEDIATE;
WITH RECURSIVE seq(n) AS (
  VALUES(1)
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 100
)
INSERT INTO bench_notes(label, payload)
SELECT 'tx-100', printf('row-%03d-', n) || hex(randomblob(128))
FROM seq;
COMMIT;
SELECT COUNT(*) AS rows, MAX(id) AS latest_id FROM bench_notes;`,
  },
  {
    id: "read-latest",
    title: "Read latest 100 rows",
    description: "Reads recent rows and is useful to compare cold vs warm cache behavior.",
    sql: `SELECT id, label, length(payload) AS payload_bytes, created_at
FROM bench_notes
ORDER BY id DESC
LIMIT 100;`,
  },
  {
    id: "aggregate",
    title: "Aggregate benchmark rows",
    description: "Runs GROUP BY / ORDER BY over the benchmark table.",
    sql: `SELECT label, COUNT(*) AS rows, AVG(length(payload)) AS avg_payload_bytes
FROM bench_notes
GROUP BY label
ORDER BY rows DESC, label ASC;`,
  },
  {
    id: "update-50",
    title: "Update latest 50 rows",
    description: "Updates recent rows inside one transaction.",
    sql: `BEGIN IMMEDIATE;
UPDATE bench_notes
SET payload = payload || '-updated'
WHERE id IN (
  SELECT id FROM bench_notes ORDER BY id DESC LIMIT 50
);
COMMIT;
SELECT COUNT(*) AS rows FROM bench_notes;`,
  },
  {
    id: "reset",
    title: "Reset benchmark table",
    description: "Drops the benchmark table so the next benchmark starts clean.",
    sql: `DROP TABLE IF EXISTS bench_notes;
SELECT 'bench_notes reset' AS status;`,
  },
];

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

    <section class="card">
      <h2>4. Benchmarks</h2>
      <p class="hint">Run predefined scenarios and compare SQL duration, VFS calls, block reads, dirty flushes, and cache behavior.</p>
      <div class="actions benchmark-actions">
        ${BENCHMARKS.map((scenario) => `<button type="button" class="secondary" data-benchmark="${escapeAttr(scenario.id)}" title="${escapeAttr(scenario.description)}">${escapeHtml(scenario.title)}</button>`).join("")}
      </div>
    </section>

    <section id="query-results" class="card result" hidden></section>
    <section id="vfs-metrics" class="card result" hidden></section>
    <section id="benchmark-results" class="card result" hidden></section>
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
const metricsPanel = $<HTMLElement>("#vfs-metrics");
const benchmarkResults = $<HTMLElement>("#benchmark-results");
const logList = $<HTMLOListElement>("#log");
const benchmarkButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-benchmark]"));

let auth: GoogleBrowserAuth | undefined;
let sqliteModule: unknown;
let sqlite3: any;
let db: ActiveDatabase | undefined;
let busy = false;
let benchmarkHistory: BenchmarkRun[] = [];
const vfsMetrics = createVfsMetricsCollector();

sqlEditor.value = DEFAULT_SQL;
configHint.textContent = "Google credentials are configured from required build-time VITE_* variables.";
pickerHint.textContent = "This demo requests only the drive.file scope. Picker grants access to the specific spreadsheet you choose.";
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
clearButton.addEventListener("click", () => {
  results.hidden = true;
  results.innerHTML = "";
  metricsPanel.hidden = true;
  metricsPanel.innerHTML = "";
});
for (const button of benchmarkButtons) {
  button.addEventListener("click", () => {
    const benchmarkId = button.dataset.benchmark;
    if (!benchmarkId) return;
    void runTask(() => runBenchmark(benchmarkId));
  });
}
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
  const vfs = await GoogleSheetsSQLiteVFS.create(vfsName, module, { spreadsheetId, databaseId: DB_ID, lockTimeoutMs: 15_000, metrics: vfsMetrics });
  sqlite.vfs_register(vfs, true);

  log("Opening SQLite database through the VFS", "info");
  db = {
    db: await sqlite.open_v2(DB_PATH, SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE, vfsName),
    spreadsheetId,
    spreadsheetUrl: spreadsheetLink,
  };
  spreadsheetInput.value = spreadsheetId;
  await sqlite.exec(db.db, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;");
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

  log("Running SQL", "info");
  const { resultSets, durationMs, snapshot } = await executeMeasuredSql(sql);
  log(`SQL executed in ${formatDuration(durationMs)}`, "ok");
  renderResults(resultSets, durationMs, "SQL editor result");
  renderVfsMetrics("SQL editor", durationMs, snapshot);
}

async function runBenchmark(benchmarkId: string): Promise<void> {
  if (!db) throw new Error("Choose or create a spreadsheet before running benchmarks.");
  const scenario = BENCHMARKS.find((candidate) => candidate.id === benchmarkId);
  if (!scenario) throw new Error(`Unknown benchmark scenario: ${benchmarkId}`);

  log(`Running benchmark: ${scenario.title}`, "info");
  const { resultSets, durationMs, snapshot } = await executeMeasuredSql(scenario.sql);
  log(`Benchmark ${scenario.title} completed in ${formatDuration(durationMs)}`, "ok");
  renderResults(resultSets, durationMs, scenario.title);
  renderVfsMetrics(`Benchmark: ${scenario.title}`, durationMs, snapshot);
  benchmarkHistory = [{ title: scenario.title, durationMs, snapshot, at: new Date() }, ...benchmarkHistory].slice(0, 20);
  renderBenchmarkHistory();
}

async function executeMeasuredSql(sql: string): Promise<{ resultSets: ResultSet[]; durationMs: number; snapshot: MetricSnapshot }> {
  if (!db) throw new Error("Choose or create a spreadsheet before running SQL.");

  vfsMetrics.reset();
  const resultSets: ResultSet[] = [];
  let active: ResultSet | undefined;
  let activeKey = "";
  const startedAt = performance.now();

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
  return { resultSets, durationMs, snapshot: vfsMetrics.snapshot() };
}

async function pickSpreadsheet(): Promise<{ spreadsheetId: string; spreadsheetUrl: string } | undefined> {
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

function createVfsMetricsCollector(): { onEvent: (event: VfsMetricEvent) => void; reset: () => void; snapshot: () => MetricSnapshot } {
  let events: VfsMetricEvent[] = [];

  return {
    onEvent(event) {
      events.push(event);
      if (events.length > 10_000) events = events.slice(-10_000);
    },
    reset() {
      events = [];
    },
    snapshot() {
      const byName = new Map<string, MetricSummary>();
      const blockSources: Record<string, number> = {};

      for (const event of events) {
        const summary = byName.get(event.name) ?? { name: event.name, count: 0, ok: 0, failed: 0, totalMs: 0, maxMs: 0, bytes: 0, blocks: 0, dirtyBlocks: 0 };
        summary.count++;
        summary.totalMs += event.durationMs;
        summary.maxMs = Math.max(summary.maxMs, event.durationMs);
        if (event.ok) summary.ok++; else summary.failed++;

        const detail = event.detail ?? {};
        summary.bytes += numericDetail(detail.bytes);
        summary.blocks += numericDetail(detail.blocks);
        summary.dirtyBlocks += numericDetail(detail.dirtyBlocks);
        byName.set(event.name, summary);

        if (event.name === "vfs.block.read" && typeof detail.source === "string") {
          blockSources[detail.source] = (blockSources[detail.source] ?? 0) + 1;
        }
      }

      const operations = Array.from(byName.values()).sort((left, right) => right.totalMs - left.totalMs || right.count - left.count);
      return { events: events.length, totalMs: operations.reduce((sum, item) => sum + item.totalMs, 0), operations, blockSources };
    },
  };
}

function numericDetail(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requiredEnv(name: string): string {
  const value = env[name]!;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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

function renderDatabaseStatus(): void {
  if (!db) {
    databaseStatus.innerHTML = `<p class="muted">No spreadsheet opened yet.</p>`;
    updateControls();
    return;
  }
  databaseStatus.innerHTML = `<p class="status-ok">Connected to spreadsheet-backed SQLite.</p><p class="spreadsheet-meta"><span>ID: <code>${escapeHtml(db.spreadsheetId)}</code></span><a href="${escapeAttr(db.spreadsheetUrl)}" target="_blank" rel="noreferrer">Open spreadsheet</a></p>`;
  updateControls();
}

function renderResults(resultSets: ResultSet[], durationMs: number, title = "Result"): void {
  results.hidden = false;
  if (!resultSets.length) {
    results.innerHTML = `<h2>${escapeHtml(title)}</h2><p class="status-ok">Query executed successfully in ${escapeHtml(formatDuration(durationMs))}. No rows were returned.</p>`;
    return;
  }
  results.innerHTML = `<h2>${escapeHtml(title)}</h2><p class="muted">${resultSets.length} result set${resultSets.length === 1 ? "" : "s"} returned in ${escapeHtml(formatDuration(durationMs))}.</p>${resultSets.map(renderSet).join("")}`;
}

function renderSet(set: ResultSet, index: number): string {
  return `<section class="result-set"><h3>Result set ${index + 1} <span>${set.rows.length} row${set.rows.length === 1 ? "" : "s"}</span></h3><div class="table-wrap"><table><thead><tr>${set.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${set.rows.map((row) => `<tr>${set.columns.map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}

function renderVfsMetrics(label: string, sqlDurationMs: number, snapshot: MetricSnapshot): void {
  metricsPanel.hidden = false;
  const remoteReads = snapshot.blockSources.sheets ?? 0;
  const cacheReads = snapshot.blockSources.cache ?? 0;
  const dirtyReads = snapshot.blockSources.dirty ?? 0;
  const topOperations = snapshot.operations.slice(0, 16);

  metricsPanel.innerHTML = `
    <h2>VFS metrics: ${escapeHtml(label)}</h2>
    <p class="muted">SQL duration: ${escapeHtml(formatDuration(sqlDurationMs))}. Captured ${snapshot.events} VFS metric event${snapshot.events === 1 ? "" : "s"}.</p>
    <div class="table-wrap"><table><tbody>
      <tr><th>Total measured VFS time</th><td>${escapeHtml(formatDuration(snapshot.totalMs))}</td></tr>
      <tr><th>Remote block reads</th><td>${remoteReads}</td></tr>
      <tr><th>Cache block reads</th><td>${cacheReads}</td></tr>
      <tr><th>Dirty block reads</th><td>${dirtyReads}</td></tr>
    </tbody></table></div>
    <section class="result-set">
      <h3>Operation breakdown <span>${snapshot.operations.length} operation type${snapshot.operations.length === 1 ? "" : "s"}</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Operation</th><th>Calls</th><th>Total</th><th>Avg</th><th>Max</th><th>Bytes</th><th>Blocks</th><th>Dirty blocks</th><th>Failures</th></tr></thead>
        <tbody>${topOperations.map(renderMetricRow).join("")}</tbody>
      </table></div>
    </section>`;
}

function renderMetricRow(summary: MetricSummary): string {
  const avgMs = summary.count === 0 ? 0 : summary.totalMs / summary.count;
  return `<tr><td>${escapeHtml(summary.name)}</td><td>${summary.count}</td><td>${escapeHtml(formatDuration(summary.totalMs))}</td><td>${escapeHtml(formatDuration(avgMs))}</td><td>${escapeHtml(formatDuration(summary.maxMs))}</td><td>${summary.bytes || ""}</td><td>${summary.blocks || ""}</td><td>${summary.dirtyBlocks || ""}</td><td>${summary.failed || ""}</td></tr>`;
}

function renderBenchmarkHistory(): void {
  benchmarkResults.hidden = benchmarkHistory.length === 0;
  if (!benchmarkHistory.length) return;
  benchmarkResults.innerHTML = `<h2>Benchmark history</h2><div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Scenario</th><th>SQL time</th><th>VFS time</th><th>Events</th><th>Remote reads</th><th>Flush calls</th></tr></thead>
    <tbody>${benchmarkHistory.map(renderBenchmarkRun).join("")}</tbody>
  </table></div>`;
}

function renderBenchmarkRun(run: BenchmarkRun): string {
  const flushCalls = run.snapshot.operations.find((operation) => operation.name === "vfs.flush")?.count ?? 0;
  return `<tr><td>${escapeHtml(run.at.toLocaleTimeString())}</td><td>${escapeHtml(run.title)}</td><td>${escapeHtml(formatDuration(run.durationMs))}</td><td>${escapeHtml(formatDuration(run.snapshot.totalMs))}</td><td>${run.snapshot.events}</td><td>${run.snapshot.blockSources.sheets ?? 0}</td><td>${flushCalls}</td></tr>`;
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
  connectButton.disabled = busy;
  createButton.disabled = busy;
  pickButton.disabled = busy;
  spreadsheetInput.disabled = busy;
  openForm.querySelector<HTMLButtonElement>("button")!.disabled = busy;
  runButton.disabled = busy || !db;
  resetButton.disabled = busy;
  clearButton.disabled = busy;
  for (const button of benchmarkButtons) button.disabled = busy || !db;
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
