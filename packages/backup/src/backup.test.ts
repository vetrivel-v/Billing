import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  DecryptError,
  BackupFormatError,
  decryptFile,
  encryptFile,
  parseHeader,
  readEncryptionInfo,
} from './crypto.js';
import {
  ContainerError,
  ContainerWriter,
  extractContainer,
  isAllowedEntryName,
  sha256OfFile,
} from './container.js';
import { expectedTriggers } from './integrity.js';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  ManifestError,
  manifestBytes,
  manifestFingerprint,
  parseManifest,
  type BackupManifest,
} from './manifest.js';
import { validatePassphrase } from './service.js';
import { passphraseProblem } from './browser.js';

const FAST = { logN: 10, r: 8, p: 1 } as const; // cheap scrypt for tests; the default (2^17) is exercised by the integration tests
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-unit-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (content: Buffer | string) => {
  const p = join(dir, `f${++n}`);
  writeFileSync(p, content);
  return p;
};
const out = () => join(dir, `o${++n}`);
const PASS = 'correct horse battery 2026';

describe('chunked authenticated encryption', () => {
  it('round-trips plain text, an empty file, one chunk, an exact multiple of the chunk size and several chunks', async () => {
    for (const size of [
      0,
      1,
      1000,
      CHUNK_SIZE - 1,
      CHUNK_SIZE,
      CHUNK_SIZE + 1,
      2 * CHUNK_SIZE,
      2 * CHUNK_SIZE + 17,
    ]) {
      const plain = randomBytes(size);
      const enc = out();
      const dec = out();
      await encryptFile(file(plain), enc, PASS, FAST);
      await decryptFile(enc, dec, PASS);
      expect(readFileSync(dec).equals(plain), `size ${size}`).toBe(true);
    }
  }, 60_000);

  it('a wrong passphrase fails, and so does any change to the file', async () => {
    const plain = randomBytes(CHUNK_SIZE + 500);
    const enc = out();
    await encryptFile(file(plain), enc, PASS, FAST);
    await expect(decryptFile(enc, out(), 'a different passphrase')).rejects.toBeInstanceOf(
      DecryptError,
    );
    const good = readFileSync(enc);
    const attempts: [string, (b: Buffer) => Buffer][] = [
      [
        'salt',
        (b) => {
          b[16] = b[16]! ^ 1;
          return b;
        },
      ],
      [
        'nonce prefix',
        (b) => {
          b[31] = b[31]! ^ 1;
          return b;
        },
      ],
      [
        'first chunk ciphertext',
        (b) => {
          b[60] = b[60]! ^ 1;
          return b;
        },
      ],
      [
        'last byte (tag)',
        (b) => {
          b[b.length - 1] = b[b.length - 1]! ^ 1;
          return b;
        },
      ],
      [
        'length field',
        (b) => {
          b[38] = b[38]! ^ 1;
          return b;
        },
      ],
      ['truncated', (b) => b.subarray(0, b.length - 1)],
      ['truncated to the first chunk', (b) => b.subarray(0, 38 + 4 + CHUNK_SIZE + 16)],
      ['appended bytes', (b) => Buffer.concat([b, Buffer.from([1, 2, 3])])],
      ['appended chunk', (b) => Buffer.concat([b, b.subarray(38)])],
    ];
    for (const [name, mutate] of attempts) {
      const bad = file(mutate(Buffer.from(good)));
      await expect(decryptFile(bad, out(), PASS), name).rejects.toThrow();
    }
  }, 60_000);

  it('reordered chunks are detected', async () => {
    const enc = out();
    await encryptFile(file(randomBytes(3 * CHUNK_SIZE + 5)), enc, PASS, FAST);
    const b = readFileSync(enc);
    const chunk = 4 + CHUNK_SIZE + 16;
    const c1 = b.subarray(38, 38 + chunk);
    const c2 = b.subarray(38 + chunk, 38 + 2 * chunk);
    const rest = b.subarray(38 + 2 * chunk);
    await expect(
      decryptFile(file(Buffer.concat([b.subarray(0, 38), c2, c1, rest])), out(), PASS),
    ).rejects.toBeInstanceOf(DecryptError);
  }, 60_000);

  it('every file has its own salt and nonce prefix, so identical data never gives identical bytes', async () => {
    const data = file(Buffer.alloc(5000, 7));
    const a = out();
    const b = out();
    await encryptFile(data, a, PASS, FAST);
    await encryptFile(data, b, PASS, FAST);
    const x = readFileSync(a);
    const y = readFileSync(b);
    expect(x.subarray(14, 30).equals(y.subarray(14, 30))).toBe(false);
    expect(x.subarray(30, 34).equals(y.subarray(30, 34))).toBe(false);
    expect(x.subarray(42, 400).equals(y.subarray(42, 400))).toBe(false);
  });

  it('never overwrites an existing file', async () => {
    const existing = file('precious');
    await expect(encryptFile(file('x'), existing, PASS, FAST)).rejects.toThrow();
    expect(readFileSync(existing, 'utf8')).toBe('precious');
  });

  it('describes the encryption without secrets, and refuses files that are not (or not safely) backups', async () => {
    const enc = out();
    await encryptFile(file('hello'), enc, PASS, FAST);
    expect(await readEncryptionInfo(enc)).toEqual({ version: 1, kdf: 'scrypt', ...FAST });
    expect(() => parseHeader(Buffer.alloc(100))).toThrow(BackupFormatError);
    const h = Buffer.from(readFileSync(enc).subarray(0, 38));
    const patched = (i: number, v: number) => {
      const c = Buffer.from(h);
      c[i] = v;
      return c;
    };
    expect(() => parseHeader(patched(9, 2))).toThrow(/different backup format/); // version
    expect(() => parseHeader(patched(10, 9))).toThrow(/key derivation/);
    expect(() => parseHeader(patched(11, 30))).toThrow(/outside the accepted range/); // a hostile cost cannot demand unbounded memory
    expect(() => parseHeader(patched(12, 200))).toThrow(/outside the accepted range/);
    expect(() => parseHeader(patched(13, 99))).toThrow(/outside the accepted range/);
    await expect(
      decryptFile(file('plain text, not a backup at all............'), out(), PASS),
    ).rejects.toBeInstanceOf(BackupFormatError);
  });
});

describe('the container', () => {
  const build = async (entries: [string, Buffer][]) => {
    const p = join(dir, `c${++n}.bin`);
    const w = await ContainerWriter.create(p);
    for (const [name, data] of entries) await w.addBuffer(name, data);
    await w.finish();
    return p;
  };
  const dest = () => mkdtempSync(join(dir, 'x-'));

  it('only the manifest and per-table data files are allowed names', () => {
    for (const ok of ['manifest.json', 'data/customers.ndjson', 'data/stock_movements.ndjson'])
      expect(isAllowedEntryName(ok), ok).toBe(true);
    for (const bad of [
      '../x',
      '../../etc/passwd',
      '/abs',
      'C:\\x',
      'data/../x.ndjson',
      'data/a/b.ndjson',
      'data/.ndjson',
      'data/Customers.ndjson',
      'manifest.json.bak',
      'other.txt',
      'data/x.ndjson\u0000.exe',
      '',
    ])
      expect(isAllowedEntryName(bad), bad).toBe(false);
  });

  it('extracts under generated names with the right size and checksum', async () => {
    const p = await build([
      ['data/a.ndjson', Buffer.from('{"x":1}\n')],
      ['manifest.json', Buffer.from('{}')],
    ]);
    const d = dest();
    const entries = await extractContainer(p, d);
    expect([...entries.keys()]).toEqual(['data/a.ndjson', 'manifest.json']);
    const a = entries.get('data/a.ndjson')!;
    expect(a.size).toBe(8);
    expect(a.path.startsWith(d)).toBe(true);
    expect(a.path).not.toContain('a.ndjson');
    expect(a.sha256).toBe(await sha256OfFile(a.path));
  });

  it('refuses hostile, duplicate, truncated and trailing-data containers, and leaves nothing outside the folder', async () => {
    const writerName = async (name: string) => {
      const w = await ContainerWriter.create(join(dir, `w${++n}.bin`));
      await expect(w.addBuffer(name, Buffer.from('x'))).rejects.toBeInstanceOf(ContainerError);
      await w.abort();
    };
    await writerName('../../evil');
    const raw = (name: string, data: Buffer, extra = Buffer.alloc(2)) => {
      const nm = Buffer.from(name, 'latin1');
      const head = Buffer.alloc(2 + nm.length + 8);
      head.writeUInt16BE(nm.length, 0);
      nm.copy(head, 2);
      head.writeBigUInt64BE(BigInt(data.length), 2 + nm.length);
      return file(Buffer.concat([head, data, extra]));
    };
    await expect(
      extractContainer(raw('../../evil.txt', Buffer.from('x')), dest()),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_ALLOWED' });
    await expect(
      extractContainer(raw('/etc/passwd', Buffer.from('x')), dest()),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_ALLOWED' });
    const dup = await build([
      ['data/a.ndjson', Buffer.from('1')],
      ['data/a.ndjson', Buffer.from('2')],
    ]);
    await expect(extractContainer(dup, dest())).rejects.toMatchObject({ code: 'DUPLICATE_ENTRY' });
    const ok = await build([['manifest.json', Buffer.from('{}')]]);
    const bytes = readFileSync(ok);
    await expect(
      extractContainer(file(bytes.subarray(0, bytes.length - 5)), dest()),
    ).rejects.toBeInstanceOf(ContainerError);
    await expect(
      extractContainer(file(Buffer.concat([bytes, Buffer.from('trailing')])), dest()),
    ).rejects.toBeInstanceOf(ContainerError);
    // an entry that claims to be larger than the whole container
    const huge = Buffer.alloc(2 + 13 + 8);
    huge.writeUInt16BE(13, 0);
    huge.write('manifest.json', 2, 'latin1');
    huge.writeBigUInt64BE(1n << 40n, 15);
    await expect(extractContainer(file(huge), dest())).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe('the manifest', () => {
  const manifest = (): BackupManifest => ({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId: '11111111-1111-4111-8111-111111111111',
    kind: 'MANUAL',
    createdAt: '2026-10-21T10:00:00.000Z',
    appVersion: '0.0.1',
    schemaVersion: '20261028000000_task_1_17_backup_recovery',
    databaseId: '22222222-2222-4222-8222-222222222222',
    organization: { id: '33333333-3333-4333-8333-333333333333', legalName: 'Sample Traders' },
    snapshot: { isolation: 'REPEATABLE READ READ ONLY' },
    attachments: { present: false, manifestVersion: 1 },
    excludedTables: ['sessions'],
    tables: [{ name: 'customers', rows: 2, bytes: 40, sha256: 'a'.repeat(64) }],
    encryption: { cipher: 'AES-256-GCM (chunked)', kdf: 'scrypt', logN: 17, r: 8, p: 1 },
  });
  it('round-trips, has a stable fingerprint, and never carries a secret', () => {
    const m = manifest();
    const bytes = manifestBytes(m);
    expect(parseManifest(bytes)).toEqual(m);
    expect(manifestFingerprint(bytes)).toBe(manifestFingerprint(manifestBytes(manifest())));
    expect(manifestFingerprint(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(bytes.toString()).not.toMatch(/passphrase|password|salt|key|secret|token/i);
  });
  it('refuses a malformed, foreign or future manifest', () => {
    const bad = (edit: (m: Loose) => void) => {
      const m = manifest() as unknown as Loose;
      edit(m);
      return () => parseManifest(Buffer.from(JSON.stringify(m)));
    };
    expect(() => parseManifest(Buffer.from('not json'))).toThrow(ManifestError);
    expect(() => parseManifest(Buffer.from('null'))).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.format = 'other';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.formatVersion = 2;
      }),
    ).toThrow(/different backup format/);
    expect(
      bad((m) => {
        m.backupId = 'x';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.kind = 'AUTO';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.createdAt = 'yesterday';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.schemaVersion = '../../x';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.databaseId = 'x';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.organization = { id: 'x', legalName: 'y' };
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.tables = [];
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.tables[0].name = '../x';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.tables.push(m.tables[0]);
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.tables[0].sha256 = 'zz';
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.tables[0].rows = -1;
      }),
    ).toThrow(ManifestError);
    expect(
      bad((m) => {
        m.encryption.kdf = 'md5';
      }),
    ).toThrow(ManifestError);
  });
});

describe('passphrase rules and the protective-trigger derivation', () => {
  it('the server and the browser agree on the passphrase rules', () => {
    const cases: [string, string | undefined, string | null][] = [
      ['', undefined, 'required'],
      ['            ', undefined, 'blank'],
      ['short', undefined, 'too_short'],
      ['x'.repeat(201), undefined, 'too_long'],
      [PASS, undefined, null],
      [PASS, 'different confirmation!', 'mismatch'],
      [PASS, PASS, null],
    ];
    for (const [p, c, want] of cases) {
      expect(passphraseProblem(p, c), `${p.length}/${c}`).toBe(want);
      const server = validatePassphrase(p, c, c !== undefined);
      expect(server.length === 0 ? null : server[0]!.rule).toBe(want);
    }
    expect(validatePassphrase(42)).toEqual([{ field: 'passphrase', rule: 'required' }]);
  });

  it('derives the triggers that must exist from the migrations, minus the ones later dropped', () => {
    const sql = [
      `CREATE TRIGGER "a_guard" BEFORE UPDATE ON "t1" FOR EACH ROW EXECUTE FUNCTION f();
       CREATE CONSTRAINT TRIGGER "b_verify" AFTER INSERT ON "t2" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION g();`,
      `DROP TRIGGER IF EXISTS "a_guard" ON "t1";
       CREATE TRIGGER "c_new" BEFORE DELETE ON "t3" FOR EACH ROW EXECUTE FUNCTION h();`,
    ];
    expect(expectedTriggers(sql)).toEqual([
      { name: 'b_verify', table: 't2' },
      { name: 'c_new', table: 't3' },
    ]);
  });
});
