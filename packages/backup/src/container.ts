/**
 * The plain (before encryption) backup container: a sequence of named entries.
 *
 *   entry = nameLength u16 | name (ASCII) | size u64 | bytes        ...        end = nameLength 0
 *
 * Names are NEVER used as file paths. On reading, every name must match a strict allow-list (the manifest and per-table data files),
 * duplicates are refused, sizes and counts are capped, and each entry is written to a file named by us. So a hostile archive cannot
 * write outside the extraction directory, whatever its entry names say.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export class ContainerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'ENTRY_NOT_ALLOWED'
      | 'DUPLICATE_ENTRY'
      | 'MALFORMED'
      | 'TOO_LARGE'
      | 'TOO_MANY_ENTRIES' = 'MALFORMED',
  ) {
    super(message);
    this.name = 'ContainerError';
  }
}

export const MANIFEST_ENTRY = 'manifest.json';
const ALLOWED = [/^manifest\.json$/, /^data\/[a-z][a-z0-9_]{0,62}\.ndjson$/];
export const isAllowedEntryName = (name: string): boolean => ALLOWED.some((r) => r.test(name));
const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 64 * 1024 ** 3;
const COPY = 1024 * 1024;

export async function sha256OfFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export class ContainerWriter {
  private constructor(private readonly fh: FileHandle) {}
  static async create(path: string): Promise<ContainerWriter> {
    return new ContainerWriter(await open(path, 'wx', 0o600));
  }
  private async head(name: string, size: number): Promise<void> {
    if (!isAllowedEntryName(name))
      throw new ContainerError('Entry name not allowed.', 'ENTRY_NOT_ALLOWED');
    const n = Buffer.from(name, 'ascii');
    const h = Buffer.alloc(2 + n.length + 8);
    h.writeUInt16BE(n.length, 0);
    n.copy(h, 2);
    h.writeBigUInt64BE(BigInt(size), 2 + n.length);
    await this.fh.write(h, 0, h.length);
  }
  async addBuffer(name: string, data: Buffer): Promise<void> {
    await this.head(name, data.length);
    await this.fh.write(data, 0, data.length);
  }
  async addFile(name: string, srcPath: string, size: number): Promise<void> {
    await this.head(name, size);
    const src = await open(srcPath, 'r');
    try {
      const buf = Buffer.alloc(COPY);
      let remaining = size;
      while (remaining > 0) {
        const { bytesRead } = await src.read(buf, 0, Math.min(COPY, remaining), null);
        if (bytesRead === 0) throw new ContainerError('Source file shorter than declared.');
        await this.fh.write(buf, 0, bytesRead);
        remaining -= bytesRead;
      }
    } finally {
      await src.close();
    }
  }
  async finish(): Promise<void> {
    await this.fh.write(Buffer.alloc(2), 0, 2);
    await this.fh.sync();
    await this.fh.close();
  }
  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }
}

export interface ExtractedEntry {
  /** The file we wrote the entry to (our own name, never the archive's). */
  path: string;
  size: number;
  sha256: string;
}

/** Extracts every entry into `destDir` under generated names and returns name -> {path, size, sha256}. */
export async function extractContainer(
  containerPath: string,
  destDir: string,
): Promise<Map<string, ExtractedEntry>> {
  const fh = await open(containerPath, 'r');
  const out = new Map<string, ExtractedEntry>();
  try {
    const total = (await fh.stat()).size;
    let pos = 0;
    const read = async (n: number): Promise<Buffer> => {
      const b = Buffer.alloc(n);
      const { bytesRead } = await fh.read(b, 0, n, pos);
      if (bytesRead !== n) throw new ContainerError('The backup container is truncated.');
      pos += n;
      return b;
    };
    for (let index = 0; ; index++) {
      const nameLen = (await read(2)).readUInt16BE(0);
      if (nameLen === 0) break;
      if (index >= MAX_ENTRIES)
        throw new ContainerError('The backup has too many entries.', 'TOO_MANY_ENTRIES');
      if (nameLen > 120)
        throw new ContainerError('An entry name is too long.', 'ENTRY_NOT_ALLOWED');
      const name = (await read(nameLen)).toString('latin1');
      if (!isAllowedEntryName(name))
        throw new ContainerError(
          'The backup contains an entry that is not allowed.',
          'ENTRY_NOT_ALLOWED',
        );
      if (out.has(name))
        throw new ContainerError('The backup contains a duplicate entry.', 'DUPLICATE_ENTRY');
      const sizeBig = (await read(8)).readBigUInt64BE(0);
      if (sizeBig > BigInt(MAX_ENTRY_BYTES) || pos + Number(sizeBig) > total)
        throw new ContainerError('An entry is larger than the backup.', 'TOO_LARGE');
      const size = Number(sizeBig);
      const path = join(destDir, `entry-${index}.part`);
      const dest = await open(path, 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        const buf = Buffer.alloc(COPY);
        let remaining = size;
        while (remaining > 0) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(COPY, remaining), pos);
          if (bytesRead === 0) throw new ContainerError('The backup container is truncated.');
          await dest.write(buf, 0, bytesRead);
          hash.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await dest.close();
      }
      out.set(name, { path, size, sha256: hash.digest('hex') });
    }
    if (pos !== total)
      throw new ContainerError('The backup container has unexpected trailing data.');
    return out;
  } finally {
    await fh.close();
  }
}
