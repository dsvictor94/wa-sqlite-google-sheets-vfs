import { DEFAULT_BLOCK_SHEET_NAME, GOOGLE_SHEETS_BLOCK_BYTES, PersistentFileSlot, BLOCK_DATA_START_ROW, BLOCK_METADATA_START_ROW } from "./constants.js";
import { GoogleSdkSheetsClient } from "./google-sheets-client.js";
import type { SheetValueUpdate } from "./types.js";
import { base64ToBytes, bytesToBase64, columnName, copyFixedBlock, quoteSheetName } from "./util.js";

export type FileMetadata = {
  slot: PersistentFileSlot;
  path: string;
  size: number;
};

export type GoogleSheetsBlockStoreOptions = {
  blockSheetName?: string;
  blocksPerStripe: number;
  stripesPerFile: number;
};

export class GoogleSheetsBlockStore {
  readonly sheetRangePrefix: string;

  constructor(
    private readonly client: GoogleSdkSheetsClient,
    private readonly options: GoogleSheetsBlockStoreOptions,
  ) {
    this.sheetRangePrefix = quoteSheetName(options.blockSheetName ?? DEFAULT_BLOCK_SHEET_NAME);
  }

  async readMetadata(slot: PersistentFileSlot): Promise<FileMetadata | null> {
    const [range] = await this.client.batchGet([this.metadataRange(slot)]);
    const row = range?.values?.[0];
    const rawSize = row?.[2];

    if (rawSize === undefined || rawSize === null || rawSize === "") return null;

    const size = Number(rawSize);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid size for Google Sheets VFS slot ${slot}: ${String(rawSize)}`);
    }

    return {
      slot,
      path: typeof row?.[1] === "string" ? row[1] : "",
      size,
    };
  }

  async writeMetadata(slot: PersistentFileSlot, path: string, size: number): Promise<void> {
    await this.client.batchUpdate([this.metadataUpdate(slot, path, size)]);
  }

  async deleteMetadata(slot: PersistentFileSlot, path: string): Promise<void> {
    await this.client.batchUpdate([
      {
        range: this.metadataRange(slot),
        values: [[slot, path, ""]],
      },
    ]);
  }

  async readBlock(slot: PersistentFileSlot, blockIndex: number): Promise<Uint8Array> {
    const [range] = await this.client.batchGet([this.blockRange(slot, blockIndex)]);
    const raw = range?.values?.[0]?.[0];

    if (typeof raw !== "string" || raw.length === 0) return new Uint8Array(GOOGLE_SHEETS_BLOCK_BYTES);
    return copyFixedBlock(base64ToBytes(raw), GOOGLE_SHEETS_BLOCK_BYTES);
  }

  async writeBlocksAndMetadata(
    slot: PersistentFileSlot,
    path: string,
    size: number,
    dirtyBlocks: ReadonlyMap<number, Uint8Array>,
  ): Promise<void> {
    const updates: SheetValueUpdate[] = [];

    for (const [blockIndex, block] of dirtyBlocks) {
      updates.push({
        range: this.blockRange(slot, blockIndex),
        values: [[bytesToBase64(copyFixedBlock(block, GOOGLE_SHEETS_BLOCK_BYTES))]],
      });
    }

    updates.push(this.metadataUpdate(slot, path, size));
    await this.client.batchUpdate(updates);
  }

  metadataRange(slot: PersistentFileSlot): string {
    return `${this.sheetRangePrefix}!A${BLOCK_METADATA_START_ROW + slot}:C${BLOCK_METADATA_START_ROW + slot}`;
  }

  blockRange(slot: PersistentFileSlot, blockIndex: number): string {
    const { row, col } = this.blockCell(slot, blockIndex);
    return `${this.sheetRangePrefix}!${columnName(col)}${row}`;
  }

  private metadataUpdate(slot: PersistentFileSlot, path: string, size: number): SheetValueUpdate {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`invalid file size ${size}`);

    return {
      range: this.metadataRange(slot),
      values: [[slot, path, size]],
    };
  }

  private blockCell(slot: PersistentFileSlot, blockIndex: number): { row: number; col: number } {
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
      throw new RangeError(`invalid block index ${blockIndex}`);
    }

    const stripe = Math.floor(blockIndex / this.options.blocksPerStripe);
    if (stripe >= this.options.stripesPerFile) {
      throw new Error("Configured Google Sheets VFS capacity exceeded");
    }

    return {
      row: BLOCK_DATA_START_ROW + slot * this.options.stripesPerFile + stripe,
      col: 2 + (blockIndex % this.options.blocksPerStripe),
    };
  }
}
