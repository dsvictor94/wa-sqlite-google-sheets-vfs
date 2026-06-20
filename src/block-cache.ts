export class BlockCache {
  private readonly entries = new Map<string, Uint8Array>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries: number) {}

  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.touch(key);
    return value.slice();
  }

  set(key: string, value: Uint8Array): void {
    this.entries.set(key, value.slice());
    this.touch(key);

    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      if (oldest) this.entries.clear();
    }
  }

  private touch(key: string): void {
    const index = this.order.indexOf(key);
    if (index >= 0) this.order.splice(index, 1);
    this.order.push(key);
  }
}
