export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function quoteSheetName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

export function columnName(index1: number): string {
  let n = index1;
  let name = "";

  while (n > 0) {
    n--;
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26);
  }

  return name;
}

export function normalizePath(filename: string | null): string {
  if (!filename) return `/${crypto.randomUUID()}`;

  try {
    return new URL(filename, "file://").pathname;
  } catch {
    return filename.startsWith("/") ? filename : `/${filename}`;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
}

export function normalizeBlock(block: Uint8Array, blockBytes: number): Uint8Array {
  if (block.byteLength === blockBytes) return block.slice();

  const out = new Uint8Array(blockBytes);
  out.set(block.subarray(0, blockBytes));
  return out;
}

export function blocksTouched(offset: number, length: number, blockBytes: number): number[] {
  if (length <= 0) return [];

  const first = Math.floor(offset / blockBytes);
  const last = Math.floor((offset + length - 1) / blockBytes);
  const indexes: number[] = [];

  for (let i = first; i <= last; i++) indexes.push(i);
  return indexes;
}

export function unique(values: number[]): number[] {
  return [...new Set(values)];
}

export function parseAppendedRow(updatedRange: string | undefined): number {
  const match = updatedRange?.match(/![A-Z]+(\d+):/i);

  if (!match?.[1]) {
    throw new Error(`Could not parse appended row from ${updatedRange ?? "empty append response"}`);
  }

  return Number(match[1]);
}
