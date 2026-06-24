import { DEFAULT_BLOCK_SHEET_NAME, GOOGLE_SHEETS_BLOCK_BYTES, PersistentFileSlot, BLOCK_DATA_START_ROW, BLOCK_METADATA_START_ROW } from "./constants.js";
import { GoogleSdkSheetsClient, type SpreadsheetBatchUpdateResult, type SpreadsheetRequest } from "./google-sheets-client.js";
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

type SheetCellData = {
  userEnteredValue: {
    numberValue?: number;
    stringValue?: string;
    boolValue?: boolean;
  };
};

type EncodedBlockCell = {
  row: number;
  col: number;
  value: string;
};

export class GoogleSheetsBlockStore {
  readonly sheetRangePrefix: string;

  constructor(
    private readonly client: GoogleSdkSheetsClient,
    private readonly options: GoogleSheetsBlockStoreOptions,
  ) {
    this.sheetRangePrefix = quoteSheetName(this.blockSheetName);
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
    leadingRequests: SpreadsheetRequest[] = [],
  ): Promise<SpreadsheetBatchUpdateResult> {
    const sheetId = await this.client.getSheetId(this.blockSheetName);
    const requests: SpreadsheetRequest[] = [...leadingRequests];

    requests.push(...this.blockUpdateRequests(sheetId, slot, dirtyBlocks));
    requests.push(this.metadataUpdateCells(sheetId, slot, path, size));

    return await this.client.spreadsheetBatchUpdate(requests);
  }

  metadataRange(slot: PersistentFileSlot): string {
    return `${this.sheetRangePrefix}!A${BLOCK_METADATA_START_ROW + slot}:C${BLOCK_METADATA_START_ROW + slot}`;
  }

  blockRange(slot: PersistentFileSlot, blockIndex: number): string {
    const { row, col } = this.blockCell(slot, blockIndex);
    return `${this.sheetRangePrefix}!${columnName(col)}${row}`;
  }

  private get blockSheetName(): string {
    return this.options.blockSheetName ?? DEFAULT_BLOCK_SHEET_NAME;
  }

  private metadataUpdate(slot: PersistentFileSlot, path: string, size: number): SheetValueUpdate {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`invalid file size ${size}`);

    return {
      range: this.metadataRange(slot),
      values: [[slot, path, size]],
    };
  }

  private metadataUpdateCells(sheetId: number, slot: PersistentFileSlot, path: string, size: number): SpreadsheetRequest {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`invalid file size ${size}`);

    const row = BLOCK_METADATA_START_ROW + slot;
    return {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: row - 1,
          endRowIndex: row,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        rows: [
          {
            values: [numberCell(slot), stringCell(path), numberCell(size)],
          },
        ],
        fields: "userEnteredValue",
      },
    };
  }

  private blockUpdateRequests(
    sheetId: number,
    slot: PersistentFileSlot,
    dirtyBlocks: ReadonlyMap<number, Uint8Array>,
  ): SpreadsheetRequest[] {
    const cells = [...dirtyBlocks]
      .map(([blockIndex, block]) => {
        const { row, col } = this.blockCell(slot, blockIndex);
        return {
          row,
          col,
          value: bytesToBase64(copyFixedBlock(block, GOOGLE_SHEETS_BLOCK_BYTES)),
        };
      })
      .sort((a, b) => a.row - b.row || a.col - b.col);

    const requests: SpreadsheetRequest[] = [];
    let i = 0;

    while (i < cells.length) {
      const first = cells[i];
      const values: SheetCellData[] = [stringCell(first.value)];
      let last = first;
      i++;

      while (i < cells.length && cells[i].row === first.row && cells[i].col === last.col + 1) {
        last = cells[i];
        values.push(stringCell(last.value));
        i++;
      }

      requests.push(this.contiguousBlockUpdate(sheetId, first, last, values));
    }

    return requests;
  }

  private contiguousBlockUpdate(
    sheetId: number,
    first: EncodedBlockCell,
    last: EncodedBlockCell,
    values: SheetCellData[],
  ): SpreadsheetRequest {
    return {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: first.row - 1,
          endRowIndex: first.row,
          startColumnIndex: first.col - 1,
          endColumnIndex: last.col,
        },
        rows: [{ values }],
        fields: "userEnteredValue",
      },
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

function stringCell(value: string): SheetCellData {
  return { userEnteredValue: { stringValue: value } };
}

function numberCell(value: number): SheetCellData {
  return { userEnteredValue: { numberValue: value } };
}
