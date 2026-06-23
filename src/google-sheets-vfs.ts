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
import type { GoogleSheetsVFSOptions } from "./types.js";
import { blocksTouched, copyFixedBlock, normalizePath } from "./util.js";

const SQLITE_LOCK_NONE = VFS.SQLITE_LOCK_NONE;

type SqliteResult = number;

export class GoogleSheetsSQLiteVFS extends FacadeVFS {
  private readonly client: GoogleSdkSheetsClient;
  private readonly store: GoogleSheetsBlockStore;
  private readonly lease: GoogleSheetsLease;
  private readonly cacheBlocks: number;
  private readonly lockReleaseDelayMs: number;
  private readonly files = new Map<number, VfsFileState>();
  private mainPath: string | null = null;
  private lastError: unknown = null;
  private flushReleaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private flushReleaseGeneration = 0;
  private pendingFlushRelease: Promise<void> | null = null;

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
    return this.withError(VFS.SQLITE_CANTOPEN, async () => {
      await this.prepareForUse();

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
    return this.withError(VFS.SQLITE_IOERR_CLOSE, async () => {
      await this.prepareForUse();

      const file = this.getFile(fileId);
      await this.flush(file);
      this.files.delete(fileId);

      if (!this.hasOpenPersistentFiles()) await this.lease.release();
      return VFS.SQLITE_OK;
    });
  }

  async jRead(fileId: number, out: Uint8Array, offset: number): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_READ, async () => {
      await this.prepareForUse();

      const file = this.getFile(fileId);
      out.fill(0);

      if (offset >= file.size) return VFS.SQLITE_IOERR_SHORT_READ;

      const readable = Math.min(out.byteLength, file.size - offset);
      let copied = 0;

      for (const blockIndex of blocksTouched(offset, readable, GOOGLE_SHEETS_BLOCK_BYTES)) {
        const block = await this.readVisibleBlock(file, blockIndex);
        const absolute = offset + copied;
        const start = absolute % GOOGLE_SHEETS_BLOCK_BYTES;
        const bytesToCopy = Math.min(readable - copied, GOOGLE_SHEETS_BLOCK_BYTES - start);

        out.set(block.subarray(start, start + bytesToCopy), copied);
        copied += bytesToCopy;
      }

      return readable < out.byteLength ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
    });
  }

  async jWrite(fileId: number, data: Uint8Array, offset: number): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_WRITE, async () => {
      await this.prepareForUse();

      const file = this.getFile(fileId);
      if (file.isPersistent && !(await this.lease.acquire())) return VFS.SQLITE_BUSY;

      let written = 0;
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
      }

      const nextSize = offset + data.byteLength;
      if (file.size < nextSize) file.markSize(nextSize);
      return VFS.SQLITE_OK;
    });
  }

  async jTruncate(fileId: number, size: number): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_TRUNCATE, async () => {
      await this.prepareForUse();

      const file = this.getFile(fileId);
      if (file.isPersistent && !(await this.lease.acquire())) return VFS.SQLITE_BUSY;

      file.markSize(size);
      file.discardBlocksAtOrAfter(Math.ceil(size / GOOGLE_SHEETS_BLOCK_BYTES));
      return VFS.SQLITE_OK;
    });
  }

  async jSync(fileId: number): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_FSYNC, async () => {
      await this.prepareForUse();
      await this.flush(this.getFile(fileId));
      return VFS.SQLITE_OK;
    });
  }

  jFileSize(fileId: number, pSize: DataView): SqliteResult {
    return this.withSyncError(VFS.SQLITE_IOERR_FSTAT, () => {
      pSize.setBigInt64(0, BigInt(this.getFile(fileId).size), true);
      return VFS.SQLITE_OK;
    });
  }

  async jLock(_fileId: number, _lockType: number): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_LOCK, async () => {
      await this.prepareForUse();
      return await this.lease.acquire() ? VFS.SQLITE_OK : VFS.SQLITE_BUSY;
    });
  }

  async jUnlock(_fileId: number, lockType: number): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_UNLOCK, async () => {
      if (lockType === SQLITE_LOCK_NONE) this.scheduleFlushAndReleaseSoon();
      return VFS.SQLITE_OK;
    });
  }

  async jAccess(filename: string, _flags: number, pResOut: DataView): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_ACCESS, async () => {
      await this.prepareForUse();

      const slot = slotForPath(normalizePath(filename), this.mainPath);
      if (slot === null) {
        pResOut.setInt32(0, 0, true);
        return VFS.SQLITE_OK;
      }

      const metadata = await this.store.readMetadata(slot);
      pResOut.setInt32(0, metadata === null ? 0 : 1, true);
      return VFS.SQLITE_OK;
    });
  }

  async jDelete(filename: string, _syncDir: number): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_DELETE, async () => {
      await this.prepareForUse();

      const path = normalizePath(filename);
      const slot = slotForPath(path, this.mainPath);
      if (slot === null) return VFS.SQLITE_OK;
      if (!(await this.lease.acquire())) return VFS.SQLITE_BUSY;

      await this.store.deleteMetadata(slot, path);
      this.clearOpenFilesForSlot(slot);
      return VFS.SQLITE_OK;
    });
  }

  async jCheckReservedLock(_fileId: number, pResOut: DataView): Promise<SqliteResult> {
    return this.withError(VFS.SQLITE_IOERR_CHECKRESERVEDLOCK, async () => {
      pResOut.setInt32(0, this.lease.isHeld ? 1 : 0, true);
      return VFS.SQLITE_OK;
    });
  }

  jSectorSize(): number {
    return 512;
  }

  jDeviceCharacteristics(): number {
    return 0;
  }

  jGetLastError(zBuf: Uint8Array): SqliteResult {
    if (this.lastError && zBuf.byteLength > 0) {
      const text = this.lastError instanceof Error
        ? this.lastError.stack ?? this.lastError.message
        : String(this.lastError);
      const out = zBuf.subarray(0, zBuf.byteLength - 1);
      const { written } = new TextEncoder().encodeInto(text, out);
      zBuf[written] = 0;
    }

    return VFS.SQLITE_OK;
  }

  private async openPersistentFile(slot: PersistentFileSlot, path: string, flags: number): Promise<number> {
    const metadata = await this.store.readMetadata(slot);
    if (metadata !== null) return metadata.size;

    if (!(flags & VFS.SQLITE_OPEN_CREATE)) throw new Error(`Google Sheets VFS file does not exist: ${path}`);
    if (!(await this.lease.acquire())) throw new BusyError("Could not acquire Google Sheets VFS lease while opening file");

    await this.store.writeMetadata(slot, path, 0);
    return 0;
  }

  private async readVisibleBlock(file: VfsFileState, blockIndex: number): Promise<Uint8Array> {
    const dirty = file.dirtyBlocks.get(blockIndex);
    if (dirty) return dirty.slice();

    if (blockIndex * GOOGLE_SHEETS_BLOCK_BYTES >= file.size) {
      return new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES);
    }

    if (file.slot === null) {
      return file.tempBlocks.get(blockIndex)?.slice() ?? new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES);
    }

    const cached = file.cache.get(blockIndex);
    if (cached) return cached;

    const block = await this.store.readBlock(file.slot, blockIndex);
    file.cache.set(blockIndex, block);
    return block;
  }

  private async flush(file: VfsFileState): Promise<void> {
    if (!file.dirtySize && file.dirtyBlocks.size === 0) return;

    if (file.slot === null) {
      file.finishFlush();
      return;
    }

    if (!(await this.lease.acquire())) throw new BusyError("Could not acquire Google Sheets VFS lease while flushing file");
    await this.store.writeBlocksAndMetadata(file.slot, file.path, file.size, file.dirtyBlocks);
    file.finishFlush();
  }

  private async prepareForUse(): Promise<void> {
    this.cancelScheduledFlushAndRelease();

    const pending = this.pendingFlushRelease;
    if (pending !== null) await pending;
  }

  private scheduleFlushAndReleaseSoon(): void {
    this.cancelScheduledFlushAndRelease();
    const generation = this.flushReleaseGeneration;

    if (this.lockReleaseDelayMs <= 0) {
      this.startFlushAndRelease(generation);
      return;
    }

    this.flushReleaseTimer = globalThis.setTimeout(() => {
      this.flushReleaseTimer = undefined;
      this.startFlushAndRelease(generation);
    }, this.lockReleaseDelayMs);
  }

  private cancelScheduledFlushAndRelease(): void {
    this.flushReleaseGeneration++;

    if (this.flushReleaseTimer === undefined) return;
    globalThis.clearTimeout(this.flushReleaseTimer);
    this.flushReleaseTimer = undefined;
  }

  private startFlushAndRelease(generation: number): void {
    const pending = this.flushAllAndReleaseForGeneration(generation);
    this.pendingFlushRelease = pending;

    void pending
      .catch((error) => {
        this.lastError = error;
      })
      .finally(() => {
        if (this.pendingFlushRelease === pending) this.pendingFlushRelease = null;
      });
  }

  private async flushAllAndReleaseForGeneration(generation: number): Promise<void> {
    if (generation !== this.flushReleaseGeneration) return;

    for (const file of this.files.values()) {
      await this.flush(file);
      if (generation !== this.flushReleaseGeneration) return;
    }

    await this.lease.release();
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
}

class BusyError extends Error {}

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
