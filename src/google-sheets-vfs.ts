import { FacadeVFS } from "wa-sqlite/src/FacadeVFS.js";
import * as VFS from "wa-sqlite/src/VFS.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import type { GoogleSheetsVFSOptions } from "./types.js";
import { base64ToBytes, blocksTouched, bytesToBase64, columnName, normalizeBlock, normalizePath, parseAppendedRow, quoteSheetName, sleep } from "./util.js";

type FileState = {
  path: string;
  slot: number | null;
  size: number;
  dirtySize: boolean;
  dirty: Map<number, Uint8Array>;
  memory: Map<number, Uint8Array>;
};

const BLOCK = 1024;
const MAIN = 0;
const JOURNAL = 1;
const WAL = 2;
const SUPER = 3;
const FILE_SLOTS = 4;

export class GoogleSheetsSQLiteVFS extends FacadeVFS {
  private readonly client: GoogleSdkSheetsClient;
  private readonly lockSheet: string;
  private readonly blockSheet: string;
  private readonly databaseId: string;
  private readonly blocksPerStripe: number;
  private readonly stripesPerFile: number;
  private readonly leaseMs: number;
  private readonly lockTimeoutMs: number;
  private readonly ownerId = crypto.randomUUID();
  private readonly files = new Map<number, FileState>();
  private mainPath: string | null = null;
  private lockToken: string | null = null;
  private lockRow: number | null = null;
  private leaseUntil = 0;
  private lastError: unknown = null;

  static async create(name: string, module: unknown, options: GoogleSheetsVFSOptions) {
    const vfs = new GoogleSheetsSQLiteVFS(name, module, options);
    await vfs.isReady();
    return vfs;
  }

  constructor(name: string, module: unknown, options: GoogleSheetsVFSOptions) {
    super(name, module);
    if (options.blockBytes && options.blockBytes !== BLOCK) throw new Error("Only 1024-byte backend blocks are supported");
    this.client = new GoogleSdkSheetsClient(options.spreadsheetId);
    this.lockSheet = quoteSheetName(options.lockSheetName ?? "__sqlite_lock");
    this.blockSheet = quoteSheetName(options.blockSheetName ?? "__sqlite_blocks");
    this.databaseId = options.databaseId ?? options.spreadsheetId;
    this.blocksPerStripe = options.blocksPerStripe ?? 256;
    this.stripesPerFile = options.stripesPerFile ?? 1024;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  getFilename(fileId: number): string {
    return this.files.get(fileId)?.path ?? `unknown:${fileId}`;
  }

  async jOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): Promise<number> {
    try {
      const path = normalizePath(name);
      const slot = this.slotFor(path, flags);
      if (flags & VFS.SQLITE_OPEN_MAIN_DB) this.mainPath = path;
      let size = 0;
      if (slot !== null) {
        size = await this.readSize(slot) ?? 0;
        if (size === 0 && !(await this.readSize(slot)) && !(flags & VFS.SQLITE_OPEN_CREATE)) return VFS.SQLITE_CANTOPEN;
        if (await this.readSize(slot) === null) await this.writeSize(slot, path, 0);
      }
      this.files.set(fileId, { path, slot, size, dirtySize: false, dirty: new Map(), memory: new Map() });
      pOutFlags.setInt32(0, flags, true);
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_CANTOPEN;
    }
  }

  async jClose(fileId: number): Promise<number> {
    try {
      const file = this.need(fileId);
      await this.flush(file);
      this.files.delete(fileId);
      if (![...this.files.values()].some((f) => f.slot !== null)) await this.unlockLease();
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_CLOSE;
    }
  }

  async jRead(fileId: number, out: Uint8Array, offset: number): Promise<number> {
    try {
      const file = this.need(fileId);
      out.fill(0);
      if (offset >= file.size) return VFS.SQLITE_IOERR_SHORT_READ;
      const readable = Math.min(out.byteLength, file.size - offset);
      let copied = 0;
      for (const blockIndex of blocksTouched(offset, readable, BLOCK)) {
        const block = await this.readVisibleBlock(file, blockIndex);
        const absolute = offset + copied;
        const start = absolute % BLOCK;
        const n = Math.min(readable - copied, BLOCK - start);
        out.set(block.subarray(start, start + n), copied);
        copied += n;
      }
      return readable < out.byteLength ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_READ;
    }
  }

  async jWrite(fileId: number, data: Uint8Array, offset: number): Promise<number> {
    try {
      const file = this.need(fileId);
      if (file.slot !== null) await this.assertLease();
      let written = 0;
      while (written < data.byteLength) {
        const absolute = offset + written;
        const blockIndex = Math.floor(absolute / BLOCK);
        const start = absolute % BLOCK;
        const n = Math.min(data.byteLength - written, BLOCK - start);
        const block = start === 0 && n === BLOCK ? data.subarray(written, written + n).slice() : await this.readVisibleBlock(file, blockIndex);
        if (!(start === 0 && n === BLOCK)) block.set(data.subarray(written, written + n), start);
        file.dirty.set(blockIndex, block);
        written += n;
      }
      if (file.size < offset + data.byteLength) {
        file.size = offset + data.byteLength;
        file.dirtySize = true;
      }
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_WRITE;
    }
  }

  async jTruncate(fileId: number, size: number): Promise<number> {
    try {
      const file = this.need(fileId);
      if (file.slot !== null) await this.assertLease();
      file.size = size;
      file.dirtySize = true;
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_TRUNCATE;
    }
  }

  async jSync(fileId: number): Promise<number> {
    try {
      await this.flush(this.need(fileId));
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_FSYNC;
    }
  }

  jFileSize(fileId: number, pSize: DataView): number {
    try {
      pSize.setBigInt64(0, BigInt(this.need(fileId).size), true);
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_FSTAT;
    }
  }

  async jLock(): Promise<number> {
    try {
      return await this.acquireLease() ? VFS.SQLITE_OK : VFS.SQLITE_BUSY;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_LOCK;
    }
  }

  async jUnlock(_fileId: number, lockType: number): Promise<number> {
    try {
      if (lockType === VFS.SQLITE_LOCK_NONE) {
        for (const file of this.files.values()) await this.flush(file);
        await this.unlockLease();
      }
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      return VFS.SQLITE_IOERR_UNLOCK;
    }
  }

  jSectorSize(): number { return 512; }
  jDeviceCharacteristics(): number { return 0; }

  private need(fileId: number): FileState {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Unknown file id ${fileId}`);
    return file;
  }

  private slotFor(path: string, flags: number): number | null {
    if (flags & VFS.SQLITE_OPEN_MAIN_DB) return MAIN;
    if (flags & VFS.SQLITE_OPEN_MAIN_JOURNAL) return JOURNAL;
    if (flags & VFS.SQLITE_OPEN_WAL) return WAL;
    if (flags & VFS.SQLITE_OPEN_SUPER_JOURNAL) return SUPER;
    if (path.endsWith("-journal")) return JOURNAL;
    if (path.endsWith("-wal")) return WAL;
    return null;
  }

  private async readVisibleBlock(file: FileState, blockIndex: number): Promise<Uint8Array> {
    const dirty = file.dirty.get(blockIndex);
    if (dirty) return dirty.slice();
    if (file.slot === null) return file.memory.get(blockIndex)?.slice() ?? new Uint8Array(BLOCK);
    const { row, col } = this.blockCell(file.slot, blockIndex);
    const [range] = await this.client.batchGet([`${this.blockSheet}!${columnName(col)}${row}`]);
    const raw = range?.values?.[0]?.[0];
    return typeof raw === "string" ? normalizeBlock(base64ToBytes(raw), BLOCK) : new Uint8Array(BLOCK);
  }

  private async flush(file: FileState): Promise<void> {
    if (!file.dirtySize && file.dirty.size === 0) return;
    if (file.slot === null) {
      for (const [key, block] of file.dirty) file.memory.set(key, block);
    } else {
      await this.assertLease();
      const updates: Array<{ range: string; values: unknown[][] }> = [];
      for (const [blockIndex, block] of file.dirty) {
        const { row, col } = this.blockCell(file.slot, blockIndex);
        updates.push({ range: `${this.blockSheet}!${columnName(col)}${row}`, values: [[bytesToBase64(block)]] });
      }
      updates.push({ range: `${this.blockSheet}!A${2 + file.slot}:C${2 + file.slot}`, values: [[file.slot, file.path, file.size]] });
      await this.client.batchUpdate(updates);
    }
    file.dirty.clear();
    file.dirtySize = false;
  }

  private async readSize(slot: number): Promise<number | null> {
    const [range] = await this.client.batchGet([`${this.blockSheet}!C${2 + slot}`]);
    const raw = range?.values?.[0]?.[0];
    return raw === undefined || raw === null || raw === "" ? null : Number(raw);
  }

  private async writeSize(slot: number, path: string, size: number): Promise<void> {
    await this.client.batchUpdate([{ range: `${this.blockSheet}!A${2 + slot}:C${2 + slot}`, values: [[slot, path, size]] }]);
  }

  private blockCell(slot: number, blockIndex: number): { row: number; col: number } {
    const stripe = Math.floor(blockIndex / this.blocksPerStripe);
    if (stripe >= this.stripesPerFile) throw new Error("configured spreadsheet capacity exceeded");
    return { row: 6 + slot * this.stripesPerFile + stripe, col: 2 + (blockIndex % this.blocksPerStripe) };
  }

  private async acquireLease(): Promise<boolean> {
    if (this.lockToken && Date.now() < this.leaseUntil - 1000) return true;
    this.lockToken = crypto.randomUUID();
    this.leaseUntil = Date.now() + this.leaseMs;
    const response = await this.client.append(`${this.lockSheet}!A:H`, [[this.databaseId, this.ownerId, this.lockToken, Date.now(), this.leaseUntil, "", "claim", navigator.userAgent]]);
    this.lockRow = parseAppendedRow(response.updates?.updatedRange);
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() < deadline) {
      const winner = await this.currentWinner();
      if (winner === this.lockToken) return true;
      await sleep(250);
    }
    return false;
  }

  private async assertLease(): Promise<void> {
    if (!this.lockToken || Date.now() >= this.leaseUntil - 1000) throw new Error("SQLite lease is not held");
  }

  private async unlockLease(): Promise<void> {
    if (!this.lockRow) return;
    await this.client.batchUpdate([{ range: `${this.lockSheet}!F${this.lockRow}`, values: [[Date.now()]] }]);
    this.lockToken = null;
    this.lockRow = null;
  }

  private async currentWinner(): Promise<string | null> {
    const [range] = await this.client.batchGet([`${this.lockSheet}!A2:H`]);
    const now = Date.now();
    const rows = range?.values ?? [];
    for (const row of rows) {
      if (row[0] === this.databaseId && row[6] === "claim" && !row[5] && Number(row[4]) > now) return String(row[2]);
    }
    return null;
  }
}
