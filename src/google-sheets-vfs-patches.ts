import * as VFS from "wa-sqlite/src/VFS.js";
import { GoogleSheetsSQLiteVFS } from "./google-sheets-vfs.js";
import { normalizePath } from "./util.js";

const BLOCK = 1024;
const MAIN = 0;
const JOURNAL = 1;
const WAL = 2;
const SUPER = 3;

type RuntimeFileState = {
  path: string;
  slot: number | null;
  size: number;
  dirtySize: boolean;
  dirty: Map<number, Uint8Array>;
  memory: Map<number, Uint8Array>;
};

type RuntimeVfs = {
  files: Map<number, RuntimeFileState>;
  mainPath: string | null;
  lastError: unknown;
  lockToken: string | null;
  leaseUntil: number;
  client: { batchUpdate(data: Array<{ range: string; values: unknown[][] }>): Promise<void> };
  blockSheet: string;
  slotFor(path: string, flags: number): number | null;
  readSize(slot: number): Promise<number | null>;
  writeSize(slot: number, path: string, size: number): Promise<void>;
  acquireLease(): Promise<boolean>;
  unlockLease(): Promise<void>;
  readVisibleBlock(file: RuntimeFileState, blockIndex: number): Promise<Uint8Array>;
  blockCell(slot: number, blockIndex: number): { row: number; col: number };
};

const proto = GoogleSheetsSQLiteVFS.prototype as unknown as Record<string, unknown>;

proto.jOpen = async function jOpenPatched(this: RuntimeVfs, name: string | null, fileId: number, flags: number, pOutFlags: DataView): Promise<number> {
  try {
    const path = normalizePath(name);
    const slot = this.slotFor(path, flags);
    if (flags & VFS.SQLITE_OPEN_MAIN_DB) this.mainPath = path;

    let size = 0;
    if (slot !== null) {
      const existingSize = await this.readSize(slot);
      if (existingSize === null) {
        if (!(flags & VFS.SQLITE_OPEN_CREATE)) return VFS.SQLITE_CANTOPEN;
        if (!(await this.acquireLease())) return VFS.SQLITE_BUSY;
        await this.writeSize(slot, path, 0);
      } else {
        size = existingSize;
      }
    }

    this.files.set(fileId, { path, slot, size, dirtySize: false, dirty: new Map(), memory: new Map() });
    pOutFlags.setInt32(0, flags, true);
    return VFS.SQLITE_OK;
  } catch (error) {
    this.lastError = error;
    return VFS.SQLITE_CANTOPEN;
  }
};

proto.jWrite = async function jWritePatched(this: RuntimeVfs, fileId: number, data: Uint8Array, offset: number): Promise<number> {
  try {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Unknown file id ${fileId}`);
    if (file.slot !== null && !(await this.acquireLease())) return VFS.SQLITE_BUSY;

    let written = 0;
    while (written < data.byteLength) {
      const absolute = offset + written;
      const blockIndex = Math.floor(absolute / BLOCK);
      const start = absolute % BLOCK;
      const n = Math.min(data.byteLength - written, BLOCK - start);
      const beyondCurrentEnd = blockIndex * BLOCK >= file.size;
      const block = start === 0 && n === BLOCK
        ? data.subarray(written, written + n).slice()
        : beyondCurrentEnd
          ? new Uint8Array(BLOCK)
          : await this.readVisibleBlock(file, blockIndex);

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
};

proto.jTruncate = async function jTruncatePatched(this: RuntimeVfs, fileId: number, size: number): Promise<number> {
  try {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Unknown file id ${fileId}`);
    if (file.slot !== null && !(await this.acquireLease())) return VFS.SQLITE_BUSY;

    file.size = size;
    file.dirtySize = true;

    for (const blockIndex of [...file.dirty.keys()]) {
      if (blockIndex * BLOCK >= size) file.dirty.delete(blockIndex);
    }

    return VFS.SQLITE_OK;
  } catch (error) {
    this.lastError = error;
    return VFS.SQLITE_IOERR_TRUNCATE;
  }
};

proto.jAccess = async function jAccessPatched(this: RuntimeVfs, filename: string, _flags: number, pResOut: DataView): Promise<number> {
  try {
    const slot = slotForPath(this, normalizePath(filename));
    if (slot === null) {
      pResOut.setInt32(0, 0, true);
      return VFS.SQLITE_OK;
    }

    const size = await this.readSize(slot);
    pResOut.setInt32(0, size === null ? 0 : 1, true);
    return VFS.SQLITE_OK;
  } catch (error) {
    this.lastError = error;
    return VFS.SQLITE_IOERR_ACCESS;
  }
};

proto.jDelete = async function jDeletePatched(this: RuntimeVfs, filename: string, _syncDir: number): Promise<number> {
  try {
    const path = normalizePath(filename);
    const slot = slotForPath(this, path);
    if (slot === null) return VFS.SQLITE_OK;
    if (!(await this.acquireLease())) return VFS.SQLITE_BUSY;

    await this.client.batchUpdate([{ range: `${this.blockSheet}!A${2 + slot}:C${2 + slot}`, values: [[slot, path, ""]] }]);

    for (const file of this.files.values()) {
      if (file.slot === slot) {
        file.size = 0;
        file.dirtySize = false;
        file.dirty.clear();
        file.memory.clear();
      }
    }

    return VFS.SQLITE_OK;
  } catch (error) {
    this.lastError = error;
    return VFS.SQLITE_IOERR_DELETE;
  }
};

proto.jCheckReservedLock = async function jCheckReservedLockPatched(this: RuntimeVfs, _fileId: number, pResOut: DataView): Promise<number> {
  try {
    pResOut.setInt32(0, this.lockToken && Date.now() < this.leaseUntil - 1000 ? 1 : 0, true);
    return VFS.SQLITE_OK;
  } catch (error) {
    this.lastError = error;
    return VFS.SQLITE_IOERR_CHECKRESERVEDLOCK;
  }
};

proto.jGetLastError = function jGetLastErrorPatched(this: RuntimeVfs, zBuf: Uint8Array): number {
  if (this.lastError) {
    const text = this.lastError instanceof Error ? this.lastError.stack ?? this.lastError.message : String(this.lastError);
    const out = zBuf.subarray(0, Math.max(0, zBuf.byteLength - 1));
    const { written } = new TextEncoder().encodeInto(text, out);
    if (written < zBuf.byteLength) zBuf[written] = 0;
  }

  return VFS.SQLITE_OK;
};

function slotForPath(vfs: RuntimeVfs, path: string): number | null {
  if (vfs.mainPath && path === vfs.mainPath) return MAIN;
  if (vfs.mainPath && path === `${vfs.mainPath}-journal`) return JOURNAL;
  if (vfs.mainPath && path === `${vfs.mainPath}-wal`) return WAL;
  if (path.endsWith("-journal")) return JOURNAL;
  if (path.endsWith("-wal")) return WAL;
  if (path.endsWith("-super-journal")) return SUPER;
  return null;
}
