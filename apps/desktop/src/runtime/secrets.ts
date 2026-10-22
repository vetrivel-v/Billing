import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Encryption that only this Windows user can undo (Electron's safeStorage, which uses DPAPI on Windows). Injected so it can be tested. */
export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface RuntimeSecrets {
  /** Password of the database role CommerceBill uses. Generated for this installation; never shipped, never shown. */
  dbPassword: string;
  /** Passphrase of the safety backups the application makes by itself before an upgrade. */
  safetyPassphrase?: string;
}

export class SecretsError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'MISSING' | 'UNREADABLE',
    message: string,
  ) {
    super(message);
  }
}

/** 32 random bytes as URL-safe text: no character needs escaping in a connection string. */
export const generatePassword = (): string => randomBytes(32).toString('base64url');

export function saveSecrets(file: string, secrets: RuntimeSecrets, cipher: SecretCipher): void {
  if (!cipher.available())
    throw new SecretsError(
      'UNAVAILABLE',
      'Windows could not protect the database credentials for this user.',
    );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, cipher.encrypt(JSON.stringify(secrets)), { mode: 0o600 });
}

export function loadSecrets(file: string, cipher: SecretCipher): RuntimeSecrets {
  if (!existsSync(file)) throw new SecretsError('MISSING', 'The database credentials are missing.');
  if (!cipher.available())
    throw new SecretsError(
      'UNAVAILABLE',
      'Windows could not unprotect the database credentials for this user.',
    );
  try {
    const parsed = JSON.parse(cipher.decrypt(readFileSync(file))) as Partial<RuntimeSecrets>;
    if (typeof parsed.dbPassword !== 'string' || parsed.dbPassword.length < 16)
      throw new Error('bad');
    return {
      dbPassword: parsed.dbPassword,
      ...(parsed.safetyPassphrase ? { safetyPassphrase: parsed.safetyPassphrase } : {}),
    };
  } catch {
    throw new SecretsError(
      'UNREADABLE',
      'The database credentials could not be read (they may belong to a different Windows account).',
    );
  }
}
