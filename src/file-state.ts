import { BlockCache } from "./block-cache.js";
import type { PersistentFileSlot } from "./constants.js";

export class VfsFileState {
  readonly dirtyBlocks = new Map<number, Uint8Array>();
  readonly tempBlocks = new Map<number, Uint8Array>();
  readonly cache: BlockCache;
  dirtySize = false;

  constructor(
    readonly path: string,
    readonly slot: PersistentFileSlot | null,
    public size: number,
    cacheBlocks: number,
  ) {
    this.cache = new BlockCache(cacheBlocks);
  }

  get isPersistent(): boolean {
    return this.slot !== null;
  }

  markBlockDirty(blockIndex: number, block: Uint8Array): void {
    this.dirtyBlocks.set(blockIndex, block.slice());
    this.cache.delete(blockIndex);
  }

  markSize(size: number): void {
    this.size = size;
    this.dirtySize = true;
  }

  finishFlush(): void {
    for (const [blockIndex, block] of this.dirtyBlocks) {
      if (this.slot === null) this.tempBlocks.set(blockIndex, block.slice());
      this.cache.set(blockIndex, block);
    }

    this.dirtyBlocks.clear();
    this.dirtySize = false;
  }

  clearVolatileState(): void {
    this.size = 0;
    this.dirtySize = false;
    this.dirtyBlocks.clear();
    this.tempBlocks.clear();
    this.cache.clear();
  }

  discardBlocksAtOrAfter(firstBlockIndex: number): void {
    for (const blockIndex of this.dirtyBlocks.keys()) {
      if (blockIndex >= firstBlockIndex) this.dirtyBlocks.delete(blockIndex);
    }

    for (const blockIndex of this.tempBlocks.keys()) {
      if (blockIndex >= firstBlockIndex) this.tempBlocks.delete(blockIndex);
    }

    this.cache.deleteFrom(firstBlockIndex);
  }
}
