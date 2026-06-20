import * as VFS from "wa-sqlite/src/VFS.js";
import { PersistentFileSlot } from "./constants.js";

export function slotForOpen(path: string, flags: number): PersistentFileSlot | null {
  if (flags & VFS.SQLITE_OPEN_MAIN_DB) return PersistentFileSlot.Main;
  if (flags & VFS.SQLITE_OPEN_MAIN_JOURNAL) return PersistentFileSlot.Journal;
  if (flags & VFS.SQLITE_OPEN_WAL) return PersistentFileSlot.Wal;
  if (flags & VFS.SQLITE_OPEN_SUPER_JOURNAL) return PersistentFileSlot.SuperJournal;

  return slotForPath(path, null);
}

export function slotForPath(path: string, mainPath: string | null): PersistentFileSlot | null {
  if (mainPath && path === mainPath) return PersistentFileSlot.Main;
  if (mainPath && path === `${mainPath}-journal`) return PersistentFileSlot.Journal;
  if (mainPath && path === `${mainPath}-wal`) return PersistentFileSlot.Wal;

  if (path.endsWith("-journal")) return PersistentFileSlot.Journal;
  if (path.endsWith("-wal")) return PersistentFileSlot.Wal;
  if (path.endsWith("-super-journal")) return PersistentFileSlot.SuperJournal;

  return null;
}
