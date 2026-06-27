import { FacadeVFS } from "wa-sqlite/src/FacadeVFS.js";
import * as VFS from "wa-sqlite/src/VFS.js";
import * as SQLite from "wa-sqlite/src/sqlite-constants.js";
import {
  DEFAULT_BLOCKS_PER_STRIPE,
  DEFAULT_CACHE_BLOCKS,
  DEFAULT_LOCK_RELEASE_DELAY_MS,
  DEFAULT_STRIPES_PER_FILE,
  GOOGLE_SHEETS_BLOCK_BYTES,
  PersistentFileSlot,
} from "./constants.js";
import { VfsFileState } from "./file-state.js";
import { slotForOpen, slotForPath } from "./file-slots.js";
import { GoogleSheetsBlockStore } from "./google-sheets-block-store.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import { GoogleSheetsLease, type GoogleSheetsWriteBatchRenewal } from "./sheets-state.js";
import type { GoogleSheetsVFSMetricDetail, GoogleSheetsVFSMetrics, GoogleSheetsVFSOptions } from "./types.js";
import { blocksTouched, copyFixedBlock, normalizePath } from "./util.js";

const LOCK_NONE = SQLite.SQLITE_LOCK_NONE;
const LOCK_SHARED = SQLite.SQLITE_LOCK_SHARED;
const LOCK_RESERVED = SQLite.SQLITE_LOCK_RESERVED;
const LOCK_EXCLUSIVE = SQLite.SQLITE_LOCK_EXCLUSIVE;
type SqliteResult = number;

export class GoogleSheetsSQLiteVFS extends FacadeVFS {
  private readonly client: GoogleSdkSheetsClient;
  private readonly store: GoogleSheetsBlockStore;
  private readonly lease: GoogleSheetsLease;
  private readonly cacheBlocks: number;
  private readonly releaseDelayMs: number;
  private readonly metrics?: GoogleSheetsVFSMetrics;
  private readonly files = new Map<number, VfsFileState>();
  private mainPath: string | null = null;
  private lastError: unknown = null;
  private releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private releaseGeneration = 0;
  private pendingRelease: Promise<void> | null = null;
  private atomicFileId: number | null = null;

  static async create(name: string, module: unknown, options: GoogleSheetsVFSOptions): Promise<GoogleSheetsSQLiteVFS> {
    const vfs = new GoogleSheetsSQLiteVFS(name, module, options);
    await vfs.isReady();
    return vfs;
  }

  constructor(name: string, module: unknown, options: GoogleSheetsVFSOptions) {
    super(name, module);
    if (options.blockBytes !== undefined && options.blockBytes !== GOOGLE_SHEETS_BLOCK_BYTES) throw new Error("Only 4096-byte Google Sheets backend blocks are supported");
    const blocksPerStripe = options.blocksPerStripe ?? DEFAULT_BLOCKS_PER_STRIPE;
    const stripesPerFile = options.stripesPerFile ?? DEFAULT_STRIPES_PER_FILE;
    this.releaseDelayMs = options.lockReleaseDelayMs ?? DEFAULT_LOCK_RELEASE_DELAY_MS;
    validatePositiveInteger("blocksPerStripe", blocksPerStripe);
    validatePositiveInteger("stripesPerFile", stripesPerFile);
    validateNonNegativeInteger("lockReleaseDelayMs", this.releaseDelayMs);
    this.client = new GoogleSdkSheetsClient(options.spreadsheetId, options.metrics);
    this.cacheBlocks = options.cacheBlocks ?? DEFAULT_CACHE_BLOCKS;
    this.metrics = options.metrics;
    this.store = new GoogleSheetsBlockStore(this.client, { blocksPerStripe, stripesPerFile });
    this.lease = new GoogleSheetsLease(this.client, {
      databaseId: options.databaseId ?? options.spreadsheetId,
      leaseMs: options.leaseMs,
      lockTimeoutMs: options.lockTimeoutMs,
      lockReleaseDelayMs: options.lockReleaseDelayMs,
    });
  }

  getFilename(fileId: number): string { return this.files.get(fileId)?.path ?? `unknown:${fileId}`; }

  async jOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): Promise<SqliteResult> {
    return await this.measured("jOpen", { fileId, flags }, VFS.SQLITE_CANTOPEN, async () => {
      await this.prepare();
      if (flags & VFS.SQLITE_OPEN_WAL) throw new Error("WAL mode is not supported by the Google Sheets VFS");
      const path = normalizePath(name);
      const slot = slotForOpen(path, flags);
      if (flags & VFS.SQLITE_OPEN_MAIN_DB) this.mainPath = path;
      const size = slot === null ? 0 : await this.openPersistentFile(slot, path, flags);
      this.files.set(fileId, new VfsFileState(path, slot, size, this.cacheBlocks));
      pOutFlags.setInt32(0, flags, true);
      return VFS.SQLITE_OK;
    });
  }

  async jClose(fileId: number): Promise<SqliteResult> {
    return await this.measured("jClose", { fileId }, VFS.SQLITE_IOERR_CLOSE, async () => {
      await this.prepare();
      const file = this.file(fileId);
      try { await this.flush(file); } catch (error) { if (file.slot === PersistentFileSlot.Main) this.clearPersistentCaches(); throw error; }
      this.files.delete(fileId);
      if (!this.hasOpenPersistentFiles()) await this.releaseLease({ close: true }, LOCK_NONE);
      return VFS.SQLITE_OK;
    });
  }

  async jRead(fileId: number, out: Uint8Array, offset: number): Promise<SqliteResult> {
    return await this.measured("jRead", { fileId, bytes: out.byteLength, offset }, VFS.SQLITE_IOERR_READ, async () => {
      await this.prepare();
      const file = this.file(fileId);
      out.fill(0);
      if (offset >= file.size) return VFS.SQLITE_IOERR_SHORT_READ;
      const readable = Math.min(out.byteLength, file.size - offset);
      let copied = 0;
      for (const blockIndex of blocksTouched(offset, readable, GOOGLE_SHEETS_BLOCK_BYTES)) {
        const block = await this.readVisibleBlock(file, blockIndex);
        const absolute = offset + copied;
        const start = absolute % GOOGLE_SHEETS_BLOCK_BYTES;
        const count = Math.min(readable - copied, GOOGLE_SHEETS_BLOCK_BYTES - start);
        out.set(block.subarray(start, start + count), copied);
        copied += count;
      }
      return readable < out.byteLength ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
    });
  }

  async jWrite(fileId: number, data: Uint8Array, offset: number): Promise<SqliteResult> {
    return await this.measured("jWrite", { fileId, bytes: data.byteLength, offset }, VFS.SQLITE_IOERR_WRITE, async () => {
      await this.prepare();
      const file = this.file(fileId);
      if (file.isPersistent && !(await this.acquireLease("jWrite", LOCK_RESERVED))) return VFS.SQLITE_BUSY;
      const originalSize = file.size;
      let written = 0;
      while (written < data.byteLength) {
        const absolute = offset + written;
        const blockIndex = Math.floor(absolute / GOOGLE_SHEETS_BLOCK_BYTES);
        const blockStart = blockIndex * GOOGLE_SHEETS_BLOCK_BYTES;
        const start = absolute % GOOGLE_SHEETS_BLOCK_BYTES;
        const count = Math.min(data.byteLength - written, GOOGLE_SHEETS_BLOCK_BYTES - start);
        const source = data.subarray(written, written + count);
        const full = start === 0 && count === GOOGLE_SHEETS_BLOCK_BYTES;
        const block = full ? copyFixedBlock(source, GOOGLE_SHEETS_BLOCK_BYTES) : blockStart >= originalSize ? new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES) : await this.readVisibleBlock(file, blockIndex);
        if (!full) block.set(source, start);
        file.markBlockDirty(blockIndex, block);
        written += count;
      }
      const nextSize = offset + data.byteLength;
      if (file.size < nextSize) file.markSize(nextSize);
      return VFS.SQLITE_OK;
    });
  }

  async jTruncate(fileId: number, size: number): Promise<SqliteResult> {
    return await this.measured("jTruncate", { fileId, size }, VFS.SQLITE_IOERR_TRUNCATE, async () => {
      await this.prepare();
      const file = this.file(fileId);
      if (file.isPersistent && !(await this.acquireLease("jTruncate", LOCK_RESERVED))) return VFS.SQLITE_BUSY;
      file.markSize(size);
      file.discardBlocksAtOrAfter(Math.ceil(size / GOOGLE_SHEETS_BLOCK_BYTES));
      return VFS.SQLITE_OK;
    });
  }

  async jSync(fileId: number): Promise<SqliteResult> {
    return await this.measured("jSync", { fileId }, VFS.SQLITE_IOERR_FSYNC, async () => {
      await this.prepare();
      const file = this.file(fileId);
      if (file.isInAtomicWrite) return VFS.SQLITE_OK;
      await this.flush(file);
      return VFS.SQLITE_OK;
    });
  }

  jFileSize(fileId: number, pSize: DataView): SqliteResult {
    try { pSize.setBigInt64(0, BigInt(this.file(fileId).size), true); return VFS.SQLITE_OK; }
    catch (error) { this.lastError = error; return VFS.SQLITE_IOERR_FSTAT; }
  }

  async jLock(_fileId: number, lockType: number): Promise<SqliteResult> {
    return await this.measured("jLock", { lockType }, VFS.SQLITE_IOERR_LOCK, async () => {
      await this.prepare();
      return await this.acquireLease("jLock", lockType) ? VFS.SQLITE_OK : VFS.SQLITE_BUSY;
    });
  }

  async jUnlock(_fileId: number, lockType: number): Promise<SqliteResult> {
    return await this.measured("jUnlock", { lockType }, VFS.SQLITE_IOERR_UNLOCK, async () => {
      if (lockType === LOCK_NONE) this.scheduleReleaseSoon();
      else await this.releaseLease({ reason: "jUnlock", lockType }, lockType);
      return VFS.SQLITE_OK;
    });
  }

  async jAccess(filename: string, _flags: number, pResOut: DataView): Promise<SqliteResult> {
    return await this.measured("jAccess", {}, VFS.SQLITE_IOERR_ACCESS, async () => {
      await this.prepare();
      const slot = slotForPath(normalizePath(filename), this.mainPath);
      if (slot === null) { pResOut.setInt32(0, 0, true); return VFS.SQLITE_OK; }
      if (!(await this.acquireLease("jAccess", LOCK_SHARED))) return VFS.SQLITE_BUSY;
      pResOut.setInt32(0, await this.store.readMetadata(slot) === null ? 0 : 1, true);
      return VFS.SQLITE_OK;
    });
  }

  async jDelete(filename: string, _syncDir: number): Promise<SqliteResult> {
    return await this.measured("jDelete", {}, VFS.SQLITE_IOERR_DELETE, async () => {
      await this.prepare();
      const path = normalizePath(filename);
      const slot = slotForPath(path, this.mainPath);
      if (slot === null) return VFS.SQLITE_OK;
      const renewal = await this.createWriteBatchRenewal("jDelete");
      if (renewal === null) return VFS.SQLITE_BUSY;
      const response = await this.store.deleteMetadata(renewal.dataSheetId, slot, path, renewal.requests);
      const renewalResult = this.lease.completeWriteBatchRenewal(response, renewal);
      if (renewalResult === "stale-but-written") this.clearAfterStaleSuccessfulWrite();
      this.clearOpenFilesForSlot(slot);
      return VFS.SQLITE_OK;
    });
  }

  async jCheckReservedLock(_fileId: number, pResOut: DataView): Promise<SqliteResult> {
    return await this.measured("jCheckReservedLock", {}, VFS.SQLITE_IOERR_CHECKRESERVEDLOCK, async () => {
      pResOut.setInt32(0, await this.lease.checkReservedLock() ? 1 : 0, true);
      return VFS.SQLITE_OK;
    });
  }

  async jFileControl(fileId: number, op: number, _pArg: DataView): Promise<SqliteResult> {
    return await this.measured("jFileControl", { fileId, op }, SQLite.SQLITE_IOERR, async () => {
      const file = this.file(fileId);
      if (file.slot !== PersistentFileSlot.Main) return SQLite.SQLITE_NOTFOUND;
      if (op === SQLite.SQLITE_FCNTL_BEGIN_ATOMIC_WRITE) return await this.beginAtomicWrite(fileId, file);
      if (op === SQLite.SQLITE_FCNTL_COMMIT_ATOMIC_WRITE) return await this.commitAtomicWrite(fileId, file);
      if (op === SQLite.SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE) return this.rollbackAtomicWrite(fileId, file);
      return SQLite.SQLITE_NOTFOUND;
    });
  }

  jSectorSize(): number { return 512; }
  jDeviceCharacteristics(fileId: number): number { return this.files.get(fileId)?.slot === PersistentFileSlot.Main ? SQLite.SQLITE_IOCAP_BATCH_ATOMIC : 0; }
  jGetLastError(zBuf: Uint8Array): SqliteResult {
    if (this.lastError && zBuf.byteLength > 0) {
      const text = this.lastError instanceof Error ? this.lastError.stack ?? this.lastError.message : String(this.lastError);
      const { written } = new TextEncoder().encodeInto(text, zBuf.subarray(0, zBuf.byteLength - 1));
      zBuf[written] = 0;
    }
    return VFS.SQLITE_OK;
  }

  private async openPersistentFile(slot: PersistentFileSlot, path: string, flags: number): Promise<number> {
    const metadata = await this.store.readMetadata(slot);
    if (metadata !== null) return metadata.size;
    if (!(flags & VFS.SQLITE_OPEN_CREATE)) throw new Error(`Google Sheets VFS file does not exist: ${path}`);
    const renewal = await this.createWriteBatchRenewal("openPersistentFile");
    if (renewal === null) throw new BusyError("Could not acquire Google Sheets VFS exclusive lock while opening file");
    const response = await this.store.writeMetadata(renewal.dataSheetId, slot, path, 0, renewal.requests);
    const renewalResult = this.lease.completeWriteBatchRenewal(response, renewal);
    if (renewalResult === "stale-but-written") this.clearAfterStaleSuccessfulWrite();
    return 0;
  }

  private async beginAtomicWrite(fileId: number, file: VfsFileState): Promise<SqliteResult> {
    await this.prepare();
    if (this.atomicFileId !== null) throw new Error(`Atomic write already active for file ${this.atomicFileId}`);
    if (!(await this.acquireLease("beginAtomicWrite", LOCK_EXCLUSIVE))) return VFS.SQLITE_BUSY;
    file.beginAtomicWrite();
    this.atomicFileId = fileId;
    return VFS.SQLITE_OK;
  }

  private async commitAtomicWrite(fileId: number, file: VfsFileState): Promise<SqliteResult> {
    try {
      if (this.atomicFileId !== fileId || !file.isInAtomicWrite) throw new Error(`No active atomic write for ${file.path}`);
      await this.flush(file);
      file.commitAtomicWrite();
      this.atomicFileId = null;
      return VFS.SQLITE_OK;
    } catch (error) {
      this.lastError = error;
      file.rollbackAtomicWrite();
      if (this.atomicFileId === fileId) this.atomicFileId = null;
      this.clearAfterPersistentWriteError();
      return SQLite.SQLITE_IOERR_COMMIT_ATOMIC;
    }
  }

  private rollbackAtomicWrite(fileId: number, file: VfsFileState): SqliteResult {
    file.rollbackAtomicWrite();
    if (this.atomicFileId === fileId) this.atomicFileId = null;
    return VFS.SQLITE_OK;
  }

  private async readVisibleBlock(file: VfsFileState, blockIndex: number): Promise<Uint8Array> {
    const dirty = file.dirtyBlocks.get(blockIndex);
    if (dirty) return dirty.slice();
    if (blockIndex * GOOGLE_SHEETS_BLOCK_BYTES >= file.size) return new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES);
    if (file.slot === null) return file.tempBlocks.get(blockIndex)?.slice() ?? new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES);
    const cached = file.cache.get(blockIndex);
    if (cached) return cached;
    const { block, controlValue } = await this.store.readBlockAndControl(file.slot, blockIndex, this.lease.controlRange);
    if (!this.lease.applyOwnerCheck(controlValue)) return this.failUnsafeSheetsRead();
    file.cache.set(blockIndex, block);
    return block;
  }

  private failUnsafeSheetsRead(): never {
    this.lease.clearLocalState();
    this.clearPersistentVolatileState();
    throw new Error("Google Sheets VFS read returned after the local lock was lost; transaction must be retried");
  }

  private async flush(file: VfsFileState): Promise<void> {
    if (!file.dirtySize && file.dirtyBlocks.size === 0) return;
    if (file.slot === null) { file.finishFlush(); return; }
    try {
      const renewal = await this.createWriteBatchRenewal("flush");
      if (renewal === null) throw new BusyError("Could not acquire Google Sheets VFS exclusive lock while flushing file");
      const response = await this.store.writeBlocksAndMetadata(renewal.dataSheetId, file.slot, file.path, file.size, file.dirtyBlocks, renewal.requests);
      const renewalResult = this.lease.completeWriteBatchRenewal(response, renewal);
      file.finishFlush();
      if (renewalResult === "stale-but-written") this.clearAfterStaleSuccessfulWrite();
    } catch (error) {
      this.clearAfterPersistentWriteError();
      throw error;
    }
  }

  private async prepare(): Promise<void> {
    this.cancelScheduledRelease();
    if (this.pendingRelease !== null) await this.pendingRelease;
  }

  private scheduleReleaseSoon(): void {
    this.cancelScheduledRelease();
    const generation = this.releaseGeneration;
    if (this.releaseDelayMs <= 0) { this.startRelease(generation); return; }
    this.releaseTimer = globalThis.setTimeout(() => { this.releaseTimer = undefined; this.startRelease(generation); }, this.releaseDelayMs);
  }

  private cancelScheduledRelease(): void {
    this.releaseGeneration++;
    if (this.releaseTimer !== undefined) globalThis.clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }

  private startRelease(generation: number): void {
    const pending = this.releaseForGeneration(generation);
    this.pendingRelease = pending;
    void pending.catch((error) => { this.lastError = error; }).finally(() => { if (this.pendingRelease === pending) this.pendingRelease = null; });
  }

  private async releaseForGeneration(generation: number): Promise<void> {
    if (generation === this.releaseGeneration) await this.releaseLease({ scheduled: true }, LOCK_NONE);
  }

  private async acquireLease(reason: string, targetLock: number): Promise<boolean> {
    const startedAt = nowMs();
    try {
      const acquired = await this.lease.acquire(targetLock);
      this.emitMetric("vfs.lease.acquire", acquired, nowMs() - startedAt, { reason, targetLock, acquired });
      return acquired;
    } catch (error) { this.emitMetric("vfs.lease.acquire", false, nowMs() - startedAt, { reason, targetLock }); throw error; }
  }

  private async createWriteBatchRenewal(reason: string): Promise<GoogleSheetsWriteBatchRenewal | null> {
    const renewal = await this.lease.createWriteBatchRenewal();
    this.emitMetric("vfs.lease.acquire", renewal !== null, 0, { reason, targetLock: LOCK_EXCLUSIVE, writeBatchRenewal: true });
    return renewal;
  }

  private async releaseLease(detail: GoogleSheetsVFSMetricDetail, targetLock: number): Promise<void> {
    const startedAt = nowMs();
    await this.lease.release(targetLock);
    this.emitMetric("vfs.lease.release", true, nowMs() - startedAt, detail);
  }

  private file(fileId: number): VfsFileState {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Unknown SQLite file id ${fileId}`);
    return file;
  }

  private hasOpenPersistentFiles(): boolean { for (const file of this.files.values()) if (file.isPersistent) return true; return false; }
  private clearOpenFilesForSlot(slot: PersistentFileSlot): void { for (const file of this.files.values()) if (file.slot === slot) file.clearVolatileState(); }
  private clearPersistentCaches(): void { for (const file of this.files.values()) if (file.isPersistent) file.cache.clear(); }
  private clearPersistentVolatileState(): void { for (const file of this.files.values()) if (file.isPersistent) file.clearVolatileState(); }
  private clearAfterPersistentWriteError(): void { this.lease.clearLocalState(); this.clearPersistentCaches(); }
  private clearAfterStaleSuccessfulWrite(): void { this.lease.clearLocalState(); this.clearPersistentCaches(); }

  private async measured(name: string, detail: GoogleSheetsVFSMetricDetail, fallback: SqliteResult, op: () => Promise<SqliteResult>): Promise<SqliteResult> {
    const startedAt = nowMs();
    try {
      const result = await op();
      this.emitMetric(name, result === VFS.SQLITE_OK || result === VFS.SQLITE_IOERR_SHORT_READ, nowMs() - startedAt, { ...detail, result });
      return result;
    } catch (error) {
      this.lastError = error;
      this.emitMetric(name, false, nowMs() - startedAt, detail);
      return error instanceof BusyError ? VFS.SQLITE_BUSY : fallback;
    }
  }

  private emitMetric(name: string, ok: boolean, durationMs: number, detail?: GoogleSheetsVFSMetricDetail): void {
    try { this.metrics?.onEvent?.({ name, ok, durationMs, detail }); } catch {}
  }
}

class BusyError extends Error {}
function validatePositiveInteger(name: string, value: number): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer, got ${value}`); }
function validateNonNegativeInteger(name: string, value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer, got ${value}`); }
function nowMs(): number { return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now(); }
