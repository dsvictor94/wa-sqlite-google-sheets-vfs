import { BlockCache } from "./block-cache.js";
import type { PersistentFileSlot } from "./constants.js";

type AtomicSnapshot = {
  size: number;
  dirtySize: boolean;
  dirtyBlocks: Map<number, Uint8Array>;
};

export class VfsFileState {
  readonly dirtyBlocks = new Map<number, Uint8Array>();
  readonly tempBlocks = new Map<number, Uint8Array>();
  readonly cache: BlockCache;
  dirtySize = false;
  private atomicSnapshot: AtomicSnapshot | null = null;

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

  get hasDirtyState(): boolean {
    return this.dirtySize || this.dirtyBlocks.size > 0;
  }

  get isInAtomicWrite(): boolean {
    return this.atomicSnapshot !== null;
  }

  markBlockDirty(blockIndex: number, block: Uint8Array): void {
    this.dirtyBlocks.set(blockIndex, block.slice());
    this.cache.delete(blockIndex);
  }

  markSize(size: number): void {
    this.size = size;
    this.dirtySize = true;
  }

  beginAtomicWrite(): void {
    if (this.atomicSnapshot !== null) throw new Error(`Atomic write already active for ${this.path}`);

    this.atomicSnapshot = {
      size: this.size,
      dirtySize: this.dirtySize,
      dirtyBlocks: cloneBlockMap(this.dirtyBlocks),
    };
  }

  commitAtomicWrite(): void {
    this.atomicSnapshot = null;
  }

  rollbackAtomicWrite(): void {
    const snapshot = this.atomicSnapshot;
    if (snapshot === null) return;

    this.size = snapshot.size;
    this.dirtySize = snapshot.dirtySize;
    this.dirtyBlocks.clear();

    for (const [blockIndex, block] of snapshot.dirtyBlocks) {
      this.dirtyBlocks.set(blockIndex, block.slice());
    }

    this.atomicSnapshot = null;
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
    this.atomicSnapshot = null;
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

function cloneBlockMap(blocks: ReadonlyMap<number, Uint8Array>): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();

  for (const [blockIndex, block] of blocks) {
    out.set(blockIndex, block.slice());
  }

  return out;
}
