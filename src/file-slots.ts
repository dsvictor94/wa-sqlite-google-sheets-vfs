import * as VFS from "wa-sqlite/src/VFS.js";
import { PersistentFileSlot } from "./constants.js";

export function slotForOpen(path: string, flags: number): PersistentFileSlot | null {
  if (flags & VFS.SQLITE_OPEN_MAIN_DB) return PersistentFileSlot.Main;

  return slotForPath(path, null);
}

export function slotForPath(path: string, mainPath: string | null): PersistentFileSlot | null {
  if (mainPath && path === mainPath) return PersistentFileSlot.Main;

  return null;
}
