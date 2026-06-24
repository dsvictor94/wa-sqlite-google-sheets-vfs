import { FacadeVFS } from "wa-sqlite/src/FacadeVFS.js";
import * as VFS from "wa-sqlite/src/VFS.js";
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
import { GoogleSheetsLease } from "./google-sheets-lease.js";
import type { GoogleSheetsVFSMetricDetail, GoogleSheetsVFSMetrics, GoogleSheetsVFSOptions } from "./types.js";
import { blocksTouched, copyFixedBlock, normalizePath } from "./util.js";

const SQLITE_LOCK_NONE = VFS.SQLITE_LOCK_NONE;

type SqliteResult = number;

export class GoogleSheetsSQLiteVFS extends FacadeVFS {
  private readonly client: GoogleSdkSheetsClient;
  private readonly store: GoogleSheetsBlockStore;
  private readonly lease: GoogleSheetsLease;
  private readonly cacheBlocks: number;
  private readonly lockReleaseDelayMs: number;
  private readonly metrics?: GoogleSheetsVFSMetrics;
  private readonly files = new Map<number, VfsFileState>();
  private mainPath: string | null = null;
  private lastError: unknown = null;
  private releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private releaseGeneration = 0;
  private pendingRelease: Promise<void> | null = null;
  private atomicFileId: number | null = null;
  private poisoned = false;

  static async create(name: string, module: unknown, options: GoogleSheetsVFSOptions): Promise<GoogleSheetsSQLiteVFS> {
    const vfs = new GoogleSheetsSQLiteVFS(name, module, options);
    await vfs.isReady();
    return vfs;
  }

  constructor(name: string, module: unknown, options: GoogleSheetsVFSOptions) {
    super(name, module);

    if (options.blockBytes !== undefined && options.blockBytes !== GOOGLE_SHEETS_BLOCK_BYTES) {
      throw new Error("Only 1024-byte Google Sheets backend blocks are supported");
    }

    const blocksPerStripe = options.blocksPerStripe ?? DEFAULT_BLOCKS_PER_STRIPE;
    const stripesPerFile = options.stripesPerFile ?? DEFAULT_STRIPES_PER_FILE;
    const lockReleaseDelayMs = options.lockReleaseDelayMs ?? DEFAULT_LOCK_RELEASE_DELAY_MS;

    validatePositiveInteger("blocksPerStripe", blocksPerStripe);
    validatePositiveInteger("stripesPerFile", stripesPerFile);
    validateNonNegativeInteger("lockReleaseDelayMs", lockReleaseDelayMs);

    this.client = new GoogleSdkSheetsClient(options.spreadsheetId);
    this.cacheBlocks = options.cacheBlocks ?? DEFAULT_CACHE_BLOCKS;
    this.lockReleaseDelayMs = lockReleaseDelayMs;
    this.metrics = options.metrics;
    this.store = new GoogleSheetsBlockStore(this.client, {
      blockSheetName: options.blockSheetName,
      blocksPerStripe,
      stripesPerFile,
    });
    this.lease = new GoogleSheetsLease(this.client, {
      databaseId: options.databaseId ?? options.spreadsheetId,
      lockSheetName: options.lockSheetName,
      leaseMs: options.leaseMs,
      lockTimeoutMs: options.lockTimeoutMs,
      lockReleaseDelayMs: options.lockReleaseDelayMs,
    });
  }

  getFilename(fileId: number): string {
    return this.files.get(fileId)?.path ?? `unknown:${fileId}`;
  }

  async jOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): Promise<SqliteResult> {
    return this.measureSqlite("jOpen", { fileId, flags, hasName: name !== null }, () => this.withError(VFS.SQLITE_CANTOPEN, async () => {
      await this.prepareForUse();
      if (flags & VFS.SQLITE_OPEN_WAL) throw new Error("WAL mode is not supported by the Google Sheets VFS");

      const path = normalizePath(name);
      const slot = slotForOpen(path, flags);
      if (flags & VFS.SQLITE_OPEN_MAIN_DB) this.mainPath = path;

      const size = slot === null ? 0 : await this.openPersistentFile(slot, path, flags);
      this.files.set(fileId, new VfsFileState(path, slot, size, this.cacheBlocks));
      pOutFlags.setInt32(0, flags, true);
      return VFS.SQLITE_OK;
    }));
  }

  async jClose(fileId: number): Promise<SqliteResult> {
    return this.measureSqlite("jClose", { fileId }, () => this.withError(VFS.SQLITE_IOERR_CLOSE, async () => {
      const file = this.getFile(fileId);
      if (this.poisoned) {
        file.clearVolatileState();
      } else {
        await this.prepareForUse();
        try {
          await this.flush(file);
        } catch (error) {
          if (file.slot === PersistentFileSlot.Main) this.poisonAfterUnknownCommit(error);
          throw error;
        }
      }

      this.files.delete(fileId);

      if (!this.hasOpenPersistentFiles()) await this.releaseLeaseAfterClose();
      return VFS.SQLITE_OK;
    }));
  }

  async jRead(fileId: number, out: Uint8Array, offset: number): Promise<SqliteResult> {
    return this.measureSqlite("jRead", { fileId, bytes: out.byteLength, offset }, () => this.withError(VFS.SQLITE_IOERR_READ, async () => {
      await this.prepareForUse();

      const file = this.getFile(fileId);
      out.fill(0);

      if (offset >= file.size) return VFS.SQLITE_IOERR_SHORT_READ;

      const readable = Math.min(out.byteLength, file.size - offset);
      const touchedBlocks = blocksTouched(offset, readable, GOOGLE_SHEETS_BLOCK_BYTES);
      let copied = 0;

      for (const blockIndex of touchedBlocks) {
        const block = await this.readVisibleBlock(file, blockIndex);
        const absolute = offset + copied;
        const start = absolute % GOOGLE_SHEETS_BLOCK_BYTES;
        const bytesToCopy = Math.min(readable - copied, GOOGLE_SHEETS_BLOCK_BYTES - start);

        out.set(block.subarray(start, start + bytesToCopy), copied);
        copied += bytesToCopy;
      }

      this.emitMetric("vfs.read.blocks", true, 0, { fileId, bytes: readable, blocks: touchedBlocks.length });
      return readable < out.byteLength ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
    }));
  }

  async jWrite(fileId: number, data: Uint8Array, offset: number): Promise<SqliteResult> {
    return this.measureSqlite("jWrite", { fileId, bytes: data.byteLength, offset }, () => this.withError(VFS.SQLITE_IOERR_WRITE, async () => {
      await this.prepareForUse();

      const file = this.getFile(fileId);
      if (file.isPersistent && !(await this.lease.acquire())) return VFS.SQLITE_BUSY;

      let written = 0;
      let blocks = 0;
      const originalSize = file.size;

      while (written < data.byteLength) {
        const absolute = offset + written;
        const blockIndex = Math.floor(absolute / GOOGLE_SHEETS_BLOCK_BYTES);
        const blockStart = blockIndex * GOOGLE_SHEETS_BLOCK_BYTES;
        const start = absolute % GOOGLE_SHEETS_BLOCK_BYTES;
        const bytesToWrite = Math.min(data.byteLength - written, GOOGLE_SHEETS_BLOCK_BYTES - start);
        const writesFullBlock = start === 0 && bytesToWrite === GOOGLE_SHEETS_BLOCK_BYTES;
        const source = data.subarray(written, written + bytesToWrite);
        const block = writesFullBlock
          ? copyFixedBlock(source, GOOGLE_SHEETS_BLOCK_BYTES)
          : blockStart >= originalSize
            ? new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES)
            : await this.readVisibleBlock(file, blockIndex);

        if (!writesFullBlock) block.set(source, start);
        file.markBlockDirty(blockIndex, block);
        written += bytesToWrite;
        blocks++;
      }

      const nextSize = offset + data.byteLength;
      if (file.size < nextSize) file.markSize(nextSize);
      this.emitMetric("vfs.write.blocks", true, 0, { fileId, bytes: data.byteLength, blocks });
      return VFS.SQLITE_OK;
    }));
  }

  async jTruncate(fileId: number, size: number): Promise<SqliteResult> {
    return this.measureSqlite("jTruncate", { fileId, size }, () => this.withError(VFS.SQLITE_IOERR_TRUNCATE, async () => {
      await this.prepareForUse();

      const file = this.getFile(fileId);
      if (file.isPersistent && !(await this.lease.acquire())) return VFS.SQLITE_BUSY;

      file.markSize(size);
      file.discardBlocksAtOrAfter(Math.ceil(size / GOOGLE_SHEETS_BLOCK_BYTES));
      return VFS.SQLITE_OK;
    }));
  }

  async jSync(fileId: number): Promise<SqliteResult> {
    return this.measureSqlite("jSync", { fileId }, () => this.withError(VFS.SQLITE_IOERR_FSYNC, async () => {
      await this.prepareForUse();
      const file = this.getFile(fileId);
      if (file.isInAtomicWrite) return VFS.SQLITE_OK;

      try {
        await this.flush(file);
        return VFS.SQLITE_OK;
      } catch (error) {
        if (file.slot === PersistentFileSlot.Main) this.poisonAfterUnknownCommit(error);
        throw error;
      }
    }));
  }

  jFileSize(fileId: number, pSize: DataView): SqliteResult {
    return this.measureSyncSqlite("jFileSize", { fileId }, () => this.withSyncError(VFS.SQLITE_IOERR_FSTAT, () => {
      pSize.setBigInt64(0, BigInt(this.getFile(fileId).size), true);
      return VFS.SQLITE_OK;
    }));
  }

  async jLock(_fileId: number, lockType: number): Promise<SqliteResult> {
    return this.measureSqlite("jLock", { lockType }, () => this.withError(VFS.SQLITE_IOERR_LOCK, async () => {
      await this.prepareForUse();
      return await this.lease.acquire() ? VFS.SQLITE_OK : VFS.SQLITE_BUSY;
    }));
  }

  async jUnlock(_fileId: number, lockType: number): Promise<SqliteResult> {
    return this.measureSqlite("jUnlock", { lockType }, () => this.withError(VFS.SQLITE_IOERR_UNLOCK, async () => {
      if (lockType === SQLITE_LOCK_NONE) {
        this.scheduleReleaseSoon();
      }

      return VFS.SQLITE_OK;
    }));
  }

  async jAccess(filename: string, _flags: number, pResOut: DataView): Promise<SqliteResult> {
    return this.measureSqlite("jAccess", {}, () => this.withError(VFS.SQLITE_IOERR_ACCESS, async () => {
      await this.prepareForUse();

      const slot = slotForPath(normalizePath(filename), this.mainPath);
      if (slot === null) {
        pResOut.setInt32(0, 0, true);
        return VFS.SQLITE_OK;
      }

      const metadata = await this.store.readMetadata(slot);
      pResOut.setInt32(0, metadata === null ? 0 : 1, true);
      return VFS.SQLITE_OK;
    }));
  }

  async jDelete(filename: string, _syncDir: number): Promise<SqliteResult> {
    return this.measureSqlite("jDelete", {}, () => this.withError(VFS.SQLITE_IOERR_DELETE, async () => {
      await this.prepareForUse();

      const path = normalizePath(filename);
      const slot = slotForPath(path, this.mainPath);
      if (slot === null) return VFS.SQLITE_OK;
      if (!(await this.lease.acquire())) return VFS.SQLITE_BUSY;

      await this.store.deleteMetadata(slot, path);
      this.clearOpenFilesForSlot(slot);
      return VFS.SQLITE_OK;
    }));
  }

  async jCheckReservedLock(_fileId: number, pResOut: DataView): Promise<SqliteResult> {
    return this.measureSqlite("jCheckReservedLock", {}, () => this.withError(VFS.SQLITE_IOERR_CHECKRESERVEDLOCK, async () => {
      pResOut.setInt32(0, this.lease.isHeld ? 1 : 0, true);
      return VFS.SQLITE_OK;
    }));
  }

  async jFileControl(fileId: number, op: number, _pArg: DataView): Promise<SqliteResult> {
    return this.measureSqlite("jFileControl", { fileId, op }, () => this.withError(VFS.SQLITE_IOERR, async () => {
      const file = this.getFile(fileId);
      if (file.slot !== PersistentFileSlot.Main) return VFS.SQLITE_NOTFOUND;

      switch (op) {
        case VFS.SQLITE_FCNTL_BEGIN_ATOMIC_WRITE:
          return await this.beginAtomicWrite(fileId, file);

        case VFS.SQLITE_FCNTL_COMMIT_ATOMIC_WRITE:
          return await this.commitAtomicWrite(fileId, file);

        case VFS.SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE:
          return this.rollbackAtomicWrite(fileId, file);

        default:
          return VFS.SQLITE_NOTFOUND;
      }
    }));
  }

  jSectorSize(): number {
    this.emitMetric("jSectorSize", true, 0);
    return 512;
  }

  jDeviceCharacteristics(fileId: number): number {
    const file = this.files.get(fileId);
    const characteristics = file?.slot === PersistentFileSlot.Main ? VFS.SQLITE_IOCAP_BATCH_ATOMIC : 0;
    this.emitMetric("jDeviceCharacteristics", true, 0, { fileId, characteristics });
    return characteristics;
  }

  jGetLastError(zBuf: Uint8Array): SqliteResult {
    return this.measureSyncSqlite("jGetLastError", { bytes: zBuf.byteLength }, () => {
      if (this.lastError && zBuf.byteLength > 0) {
        const text = this.lastError instanceof Error
          ? this.lastError.stack ?? this.lastError.message
          : String(this.lastError);
        const out = zBuf.subarray(0, zBuf.byteLength - 1);
        const { written } = new TextEncoder().encodeInto(text, out);
        zBuf[written] = 0;
      }

      return VFS.SQLITE_OK;
    });
  }

  private async openPersistentFile(slot: PersistentFileSlot, path: string, flags: number): Promise<number> {
    const metadata = await this.store.readMetadata(slot);
    if (metadata !== null) return metadata.size;

    if (!(flags & VFS.SQLITE_OPEN_CREATE)) throw new Error(`Google Sheets VFS file does not exist: ${path}`);
    if (!(await this.lease.acquire())) throw new BusyError("Could not acquire Google Sheets VFS lease while opening file");

    await this.store.writeMetadata(slot, path, 0);
    return 0;
  }

  private async beginAtomicWrite(fileId: number, file: VfsFileState): Promise<SqliteResult> {
    await this.prepareForUse();
    if (this.atomicFileId !== null) throw new Error(`Atomic write already active for file ${this.atomicFileId}`);
    if (!(await this.lease.acquire())) return VFS.SQLITE_BUSY;

    file.beginAtomicWrite();
    this.atomicFileId = fileId;
    this.emitMetric("vfs.atomic.begin", true, 0, { fileId, file: file.path });
    return VFS.SQLITE_OK;
  }

  private async commitAtomicWrite(fileId: number, file: VfsFileState): Promise<SqliteResult> {
    try {
      if (this.atomicFileId !== fileId || !file.isInAtomicWrite) {
        throw new Error(`No active atomic write for ${file.path}`);
      }

      await this.flush(file);
      file.commitAtomicWrite();
      this.atomicFileId = null;
      this.emitMetric("vfs.atomic.commit", true, 0, { fileId, file: file.path });
      return VFS.SQLITE_OK;
    } catch (error) {
      this.poisonAfterUnknownCommit(error);
      this.emitMetric("vfs.atomic.commit", false, 0, { fileId, file: file.path });
      return VFS.SQLITE_IOERR_COMMIT_ATOMIC;
    }
  }

  private rollbackAtomicWrite(fileId: number, file: VfsFileState): SqliteResult {
    file.rollbackAtomicWrite();
    if (this.atomicFileId === fileId) this.atomicFileId = null;
    this.emitMetric("vfs.atomic.rollback", true, 0, { fileId, file: file.path });
    return VFS.SQLITE_OK;
  }

  private async readVisibleBlock(file: VfsFileState, blockIndex: number): Promise<Uint8Array> {
    const startedAt = nowMs();
    const detail = { file: file.path, slot: file.slot === null ? "temp" : file.slot, blockIndex };
    const dirty = file.dirtyBlocks.get(blockIndex);
    if (dirty) {
      this.emitMetric("vfs.block.read", true, nowMs() - startedAt, { ...detail, source: "dirty" });
      return dirty.slice();
    }

    if (blockIndex * GOOGLE_SHEETS_BLOCK_BYTES >= file.size) {
      this.emitMetric("vfs.block.read", true, nowMs() - startedAt, { ...detail, source: "zero" });
      return new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES);
    }

    if (file.slot === null) {
      const temp = file.tempBlocks.get(blockIndex)?.slice() ?? new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES);
      this.emitMetric("vfs.block.read", true, nowMs() - startedAt, { ...detail, source: "temp" });
      return temp;
    }

    const cached = file.cache.get(blockIndex);
    if (cached) {
      this.emitMetric("vfs.block.read", true, nowMs() - startedAt, { ...detail, source: "cache" });
      return cached;
    }

    const block = await this.store.readBlock(file.slot, blockIndex);
    file.cache.set(blockIndex, block);
    this.emitMetric("vfs.block.read", true, nowMs() - startedAt, { ...detail, source: "sheets" });
    return block;
  }

  private async flush(file: VfsFileState): Promise<void> {
    const startedAt = nowMs();
    const detail = {
      file: file.path,
      slot: file.slot === null ? "temp" : file.slot,
      dirtyBlocks: file.dirtyBlocks.size,
      dirtySize: file.dirtySize,
    };

    try {
      if (this.poisoned) throw new PoisonedVfsError("Google Sheets VFS connection is poisoned after an unknown commit outcome");

      if (!file.dirtySize && file.dirtyBlocks.size === 0) {
        this.emitMetric("vfs.flush", true, nowMs() - startedAt, { ...detail, noop: true });
        return;
      }

      if (file.slot === null) {
        file.finishFlush();
        this.emitMetric("vfs.flush", true, nowMs() - startedAt, { ...detail, temp: true });
        return;
      }

      if (!(await this.lease.acquire())) throw new BusyError("Could not acquire Google Sheets VFS lease while flushing file");
      await this.store.writeBlocksAndMetadata(file.slot, file.path, file.size, file.dirtyBlocks);
      file.finishFlush();
      this.emitMetric("vfs.flush", true, nowMs() - startedAt, detail);
    } catch (error) {
      this.emitMetric("vfs.flush", false, nowMs() - startedAt, detail);
      throw error;
    }
  }

  private async prepareForUse(): Promise<void> {
    if (this.poisoned) throw new PoisonedVfsError("Google Sheets VFS connection is poisoned after an unknown commit outcome; close and reopen it");

    this.cancelScheduledRelease();

    const pending = this.pendingRelease;
    if (pending !== null) await pending;
  }

  private poisonAfterUnknownCommit(error: unknown): void {
    this.lastError = error;
    this.poisoned = true;
    this.atomicFileId = null;
    this.cancelScheduledRelease();

    for (const file of this.files.values()) {
      file.clearVolatileState();
    }
  }

  private scheduleReleaseSoon(): void {
    this.cancelScheduledRelease();
    const generation = this.releaseGeneration;

    if (this.lockReleaseDelayMs <= 0) {
      this.startRelease(generation);
      return;
    }

    this.releaseTimer = globalThis.setTimeout(() => {
      this.releaseTimer = undefined;
      this.startRelease(generation);
    }, this.lockReleaseDelayMs);
  }

  private cancelScheduledRelease(): void {
    this.releaseGeneration++;

    if (this.releaseTimer === undefined) return;
    globalThis.clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }

  private startRelease(generation: number): void {
    const pending = this.releaseForGeneration(generation);
    this.pendingRelease = pending;

    void pending
      .catch((error) => {
        this.lastError = error;
      })
      .finally(() => {
        if (this.pendingRelease === pending) this.pendingRelease = null;
      });
  }

  private async releaseForGeneration(generation: number): Promise<void> {
    if (generation !== this.releaseGeneration) return;
    const startedAt = nowMs();
    try {
      await this.lease.release();
      this.emitMetric("vfs.lease.release", true, nowMs() - startedAt, { scheduled: true });
    } catch (error) {
      this.emitMetric("vfs.lease.release", false, nowMs() - startedAt, { scheduled: true });
      throw error;
    }
  }

  private async releaseLeaseAfterClose(): Promise<void> {
    try {
      await this.lease.release();
    } catch (error) {
      this.lastError = error;
      if (!this.poisoned) throw error;
    }
  }

  private getFile(fileId: number): VfsFileState {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Unknown SQLite file id ${fileId}`);
    return file;
  }

  private hasOpenPersistentFiles(): boolean {
    for (const file of this.files.values()) {
      if (file.isPersistent) return true;
    }

    return false;
  }

  private clearOpenFilesForSlot(slot: PersistentFileSlot): void {
    for (const file of this.files.values()) {
      if (file.slot === slot) file.clearVolatileState();
    }
  }

  private async withError(fallback: SqliteResult, operation: () => Promise<SqliteResult>): Promise<SqliteResult> {
    try {
      return await operation();
    } catch (error) {
      this.lastError = error;
      return error instanceof BusyError ? VFS.SQLITE_BUSY : fallback;
    }
  }

  private withSyncError(fallback: SqliteResult, operation: () => SqliteResult): SqliteResult {
    try {
      return operation();
    } catch (error) {
      this.lastError = error;
      return fallback;
    }
  }

  private async measureSqlite(name: string, detail: GoogleSheetsVFSMetricDetail, operation: () => Promise<SqliteResult>): Promise<SqliteResult> {
    const startedAt = nowMs();
    try {
      const result = await operation();
      this.emitMetric(name, result === VFS.SQLITE_OK || (name === "jRead" && result === VFS.SQLITE_IOERR_SHORT_READ), nowMs() - startedAt, { ...detail, result });
      return result;
    } catch (error) {
      this.emitMetric(name, false, nowMs() - startedAt, detail);
      throw error;
    }
  }

  private measureSyncSqlite(name: string, detail: GoogleSheetsVFSMetricDetail, operation: () => SqliteResult): SqliteResult {
    const startedAt = nowMs();
    try {
      const result = operation();
      this.emitMetric(name, result === VFS.SQLITE_OK, nowMs() - startedAt, { ...detail, result });
      return result;
    } catch (error) {
      this.emitMetric(name, false, nowMs() - startedAt, detail);
      throw error;
    }
  }

  private emitMetric(name: string, ok: boolean, durationMs: number, detail?: GoogleSheetsVFSMetricDetail): void {
    try {
      this.metrics?.onEvent?.({ name, ok, durationMs, detail });
    } catch {
      // Metrics must never affect SQLite behavior.
    }
  }
}

class BusyError extends Error {}
class PoisonedVfsError extends Error {}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
