export class BlockCache {
  private readonly blocks = new Map<number, Uint8Array>();

  constructor(private readonly maxBlocks: number) {}

  get(blockIndex: number): Uint8Array | undefined {
    const cached = this.blocks.get(blockIndex);
    if (!cached) return undefined;

    this.blocks.delete(blockIndex);
    this.blocks.set(blockIndex, cached);
    return cached.slice();
  }

  set(blockIndex: number, block: Uint8Array): void {
    if (this.maxBlocks <= 0) return;

    this.blocks.delete(blockIndex);
    this.blocks.set(blockIndex, block.slice());
    this.evictOldestBlocks();
  }

  delete(blockIndex: number): void {
    this.blocks.delete(blockIndex);
  }

  deleteFrom(firstBlockIndex: number): void {
    for (const blockIndex of this.blocks.keys()) {
      if (blockIndex >= firstBlockIndex) this.blocks.delete(blockIndex);
    }
  }

  clear(): void {
    this.blocks.clear();
  }

  private evictOldestBlocks(): void {
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value as number | undefined;
      if (oldest === undefined) return;
      this.blocks.delete(oldest);
    }
  }
}
