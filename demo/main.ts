import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "wa-sqlite";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { GoogleBrowserAuth, GoogleSheetsSQLiteVFS, createGoogleSheetsVfsSpreadsheet, ensureGoogleSheetsVfsTabs } from "../dist/index.js";

type LogLevel = "info" | "ok" | "error";

const GOOGLE_CLIENT_ID = "429619695141-pamk25d0kjf42pb09trdao4ostc3132o.apps.googleusercontent.com";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app element");

app.innerHTML = `
  <section class="hero">
    <p class="eyebrow">wa-sqlite + Google Sheets VFS</p>
    <h1>SQLite backed by your Google spreadsheet.</h1>
    <p class="lede">Connect with Google, create a fresh spreadsheet in your Drive, run an INSERT, then SELECT the row back through the VFS.</p>
  </section>

  <section class="card">
    <p>This demo uses the configured OAuth Client ID and requests access only when you click the button.</p>
    <button id="run" type="button">Connect Google Drive and run SQLite smoke test</button>
  </section>

  <section class="card">
    <h2>Status</h2>
    <ol id="log" class="log"></ol>
  </section>

  <section id="result" class="card result" hidden></section>
`;

const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const logList = document.querySelector<HTMLOListElement>("#log")!;
const result = document.querySelector<HTMLElement>("#result")!;

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  logList.innerHTML = "";
  result.hidden = true;

  try {
    log("Loading Google SDK and requesting Sheets/Drive access", "info");
    const auth = new GoogleBrowserAuth({ clientId: GOOGLE_CLIENT_ID });
    await auth.init();
    await auth.authorize("consent");
    log("Google access granted", "ok");

    log("Creating a new spreadsheet in the signed-in user's Drive", "info");
    const spreadsheet = await createGoogleSheetsVfsSpreadsheet();
    await ensureGoogleSheetsVfsTabs(spreadsheet.spreadsheetId);
    log(`Spreadsheet created: ${spreadsheet.spreadsheetId}`, "ok");

    log("Loading wa-sqlite async build", "info");
    const module = await SQLiteESMFactory({ locateFile: (file: string) => file.endsWith(".wasm") ? wasmUrl : file });
    const sqlite3 = SQLite.Factory(module);

    log("Registering Google Sheets VFS", "info");
    const vfs = await GoogleSheetsSQLiteVFS.create("google-sheets", module, {
      spreadsheetId: spreadsheet.spreadsheetId,
      databaseId: `demo-${spreadsheet.spreadsheetId}`,
      lockTimeoutMs: 15_000,
    });
    sqlite3.vfs_register(vfs, true);

    log("Opening SQLite database through the VFS", "info");
    const db = await sqlite3.open_v2("/demo.db", SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE, "google-sheets");
    const rows: Array<Record<string, unknown>> = [];

    try {
      await sqlite3.exec(db, `
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS demo_events (
          id INTEGER PRIMARY KEY,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      log("Table ready", "ok");

      const message = `Hello from Google Sheets VFS at ${new Date().toISOString()}`;
      await sqlite3.exec(db, `INSERT INTO demo_events(message, created_at) VALUES (${sqlString(message)}, ${sqlString(new Date().toISOString())});`);
      log("Inserted one row", "ok");

      await sqlite3.exec(db, "SELECT id, message, created_at FROM demo_events ORDER BY id DESC LIMIT 1;", (row: unknown[], columns: string[]) => {
        rows.push(Object.fromEntries(columns.map((column, index) => [column, row[index]])));
      });
      log("Selected row back from SQLite", "ok");
    } finally {
      await sqlite3.close(db);
    }

    renderResult(spreadsheet.spreadsheetUrl, rows);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error), "error");
    console.error(error);
  } finally {
    runButton.disabled = false;
  }
});

function log(message: string, level: LogLevel): void {
  const item = document.createElement("li");
  item.className = level;
  item.textContent = message;
  logList.appendChild(item);
}

function renderResult(spreadsheetUrl: string, rows: Array<Record<string, unknown>>): void {
  result.hidden = false;
  result.innerHTML = `
    <h2>Result</h2>
    <p><a href="${escapeAttr(spreadsheetUrl)}" target="_blank" rel="noreferrer">Open the created spreadsheet</a></p>
    <pre>${escapeHtml(JSON.stringify(rows, null, 2))}</pre>
  `;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
