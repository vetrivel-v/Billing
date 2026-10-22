/**
 * Authenticated, chunked file encryption (ADR-0027). Standard primitives only: AES-256-GCM per chunk, a key derived from the user's
 * passphrase with scrypt, a random salt and a random nonce prefix per file.
 *
 * Layout:  header | chunk*   where header = "CBBACKUP" | version u16 | kdf id u8 (1 = scrypt) | logN u8 | r u8 | p u8 | salt[16] |
 * noncePrefix[4] | chunkSize u32, and chunk = length u32 | ciphertext | tag[16].
 *
 * Each chunk's nonce is noncePrefix || chunk counter (u64), and its additional authenticated data is the whole header plus a
 * "final chunk" flag. So a wrong passphrase, a changed byte anywhere, a reordered or removed chunk, a truncated file and an
 * appended chunk are all detected before any plaintext is released. (This is the STREAM construction over AES-GCM.)
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

export const MAGIC = Buffer.from('CBBACKUP', 'ascii');
export const ENCRYPTION_VERSION = 1;
const KDF_SCRYPT = 1;
export const CHUNK_SIZE = 1024 * 1024;
const TAG = 16;
const HEADER_LENGTH = 8 + 2 + 1 + 1 + 1 + 1 + 16 + 4 + 4;
/** scrypt cost used for new backups (about 128 MiB of memory). */
export const DEFAULT_KDF = { logN: 17, r: 8, p: 1 } as const;
/** Upper bounds accepted when READING a file, so a hostile backup cannot demand unbounded memory or time. */
const MAX_LOG_N = 18;
const MAX_R = 16;
const MAX_P = 4;

export class DecryptError extends Error {
  constructor(
    message = 'The backup could not be decrypted: wrong passphrase, or the file is damaged or has been changed.',
  ) {
    super(message);
    this.name = 'DecryptError';
  }
}
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export interface KdfParams {
  logN: number;
  r: number;
  p: number;
}

function deriveKey(passphrase: string, salt: Buffer, k: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const N = 2 ** k.logN;
    scryptCb(
      passphrase.normalize('NFKC'),
      salt,
      32,
      { N, r: k.r, p: k.p, maxmem: 128 * N * k.r * 2 + 32 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function buildHeader(k: KdfParams, salt: Buffer, noncePrefix: Buffer): Buffer {
  const h = Buffer.alloc(HEADER_LENGTH);
  let o = MAGIC.copy(h, 0);
  o = h.writeUInt16BE(ENCRYPTION_VERSION, o);
  o = h.writeUInt8(KDF_SCRYPT, o);
  o = h.writeUInt8(k.logN, o);
  o = h.writeUInt8(k.r, o);
  o = h.writeUInt8(k.p, o);
  o += salt.copy(h, o);
  o += noncePrefix.copy(h, o);
  h.writeUInt32BE(CHUNK_SIZE, o);
  return h;
}

export interface ParsedHeader {
  kdf: KdfParams;
  salt: Buffer;
  noncePrefix: Buffer;
  chunkSize: number;
  raw: Buffer;
}

/** Reads and validates the plain header. Throws BackupFormatError for anything that is not a version-1 CommerceBill backup. */
export function parseHeader(raw: Buffer): ParsedHeader {
  if (raw.length < HEADER_LENGTH || !raw.subarray(0, 8).equals(MAGIC))
    throw new BackupFormatError('This file is not a CommerceBill backup.');
  const version = raw.readUInt16BE(8);
  if (version !== ENCRYPTION_VERSION)
    throw new BackupFormatError(
      'This backup was made by a different backup format and cannot be read by this version.',
    );
  if (raw.readUInt8(10) !== KDF_SCRYPT)
    throw new BackupFormatError('Unsupported backup key derivation.');
  const kdf = { logN: raw.readUInt8(11), r: raw.readUInt8(12), p: raw.readUInt8(13) };
  if (
    kdf.logN < 10 ||
    kdf.logN > MAX_LOG_N ||
    kdf.r < 1 ||
    kdf.r > MAX_R ||
    kdf.p < 1 ||
    kdf.p > MAX_P
  )
    throw new BackupFormatError(
      'The backup declares key-derivation settings outside the accepted range.',
    );
  const chunkSize = raw.readUInt32BE(34);
  if (chunkSize < 1024 || chunkSize > 16 * 1024 * 1024)
    throw new BackupFormatError('The backup declares an unsupported chunk size.');
  return {
    kdf,
    salt: Buffer.from(raw.subarray(14, 30)),
    noncePrefix: Buffer.from(raw.subarray(30, 34)),
    chunkSize,
    raw: Buffer.from(raw.subarray(0, HEADER_LENGTH)),
  };
}

const nonceFor = (prefix: Buffer, counter: number): Buffer => {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
};
const aadFor = (header: Buffer, final: boolean): Buffer =>
  Buffer.concat([header, Buffer.from([final ? 1 : 0])]);

async function readFull(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/** Encrypts `plainPath` to `outPath` (created exclusively: an existing file is never overwritten). */
export async function encryptFile(
  plainPath: string,
  outPath: string,
  passphrase: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<{ bytes: number }> {
  const salt = randomBytes(16);
  const noncePrefix = randomBytes(4);
  const key = await deriveKey(passphrase, salt, kdf);
  const header = buildHeader(kdf, salt, noncePrefix);
  const input = await open(plainPath, 'r');
  const output = await open(outPath, 'wx', 0o600);
  try {
    let written = 0;
    const write = async (b: Buffer) => {
      await output.write(b, 0, b.length);
      written += b.length;
    };
    await write(header);
    let position = 0;
    let current = await readFull(input, CHUNK_SIZE, position);
    position += current.length;
    for (let counter = 0; ; counter++) {
      const next =
        current.length === CHUNK_SIZE
          ? await readFull(input, CHUNK_SIZE, position)
          : Buffer.alloc(0);
      position += next.length;
      // The chunk is final when nothing follows it; a plaintext of an exact multiple of the chunk size ends with an empty final chunk.
      const final = next.length === 0;
      const cipher = createCipheriv('aes-256-gcm', key, nonceFor(noncePrefix, counter));
      cipher.setAAD(aadFor(header, final));
      const body = Buffer.concat([cipher.update(current), cipher.final()]);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      await write(Buffer.concat([len, body, cipher.getAuthTag()]));
      if (final) break;
      current = next;
    }
    await output.sync();
    return { bytes: written };
  } finally {
    await input.close();
    await output.close();
  }
}

/**
 * Decrypts `inPath` to `outPath` (created exclusively). Throws DecryptError for a wrong passphrase OR any change to the file,
 * and BackupFormatError when the file is not a readable CommerceBill backup. On any failure the partial output is the caller's
 * to delete (the backup service removes its whole temporary directory).
 */
export async function decryptFile(
  inPath: string,
  outPath: string,
  passphrase: string,
): Promise<{ bytes: number }> {
  const input = await open(inPath, 'r');
  try {
    const size = (await input.stat()).size;
    const header = parseHeader(await readFull(input, HEADER_LENGTH, 0));
    const key = await deriveKey(passphrase, header.salt, header.kdf);
    const output = await open(outPath, 'wx', 0o600);
    try {
      let position = HEADER_LENGTH;
      let counter = 0;
      let bytes = 0;
      for (;;) {
        const lenBuf = await readFull(input, 4, position);
        if (lenBuf.length !== 4) throw new DecryptError();
        const bodyLength = lenBuf.readUInt32BE(0);
        if (bodyLength > header.chunkSize) throw new DecryptError();
        const end = position + 4 + bodyLength + TAG;
        if (end > size) throw new DecryptError(); // truncated
        const final = end === size;
        const body = await readFull(input, bodyLength + TAG, position + 4);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          nonceFor(header.noncePrefix, counter),
        );
        decipher.setAAD(aadFor(header.raw, final));
        decipher.setAuthTag(body.subarray(bodyLength));
        let plain: Buffer;
        try {
          plain = Buffer.concat([decipher.update(body.subarray(0, bodyLength)), decipher.final()]);
        } catch {
          throw new DecryptError();
        }
        await output.write(plain, 0, plain.length);
        bytes += plain.length;
        if (final) break;
        position = end;
        counter++;
      }
      await output.sync();
      return { bytes };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** The plain, non-secret header facts of a backup file (never the key or passphrase). */
export async function readEncryptionInfo(
  path: string,
): Promise<{ version: number; kdf: 'scrypt'; logN: number; r: number; p: number }> {
  const fh = await open(path, 'r');
  try {
    const h = parseHeader(await readFull(fh, HEADER_LENGTH, 0));
    return { version: ENCRYPTION_VERSION, kdf: 'scrypt', ...h.kdf };
  } finally {
    await fh.close();
  }
}
