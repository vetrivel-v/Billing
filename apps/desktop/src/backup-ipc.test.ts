import { describe, expect, it } from 'vitest';
import { BACKUP_CHANNELS, registerChosenPath } from './backup-ipc.js';

const api = {
  baseUrl: 'http://127.0.0.1:4310',
  launchSecret: 'L'.repeat(64),
  controlSecret: 'C'.repeat(64),
};
const fake = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('backup chooser contract', () => {
  it('has exactly two channels and neither takes an argument', () => {
    expect(BACKUP_CHANNELS).toEqual({
      chooseDestination: 'backup:choose-destination',
      chooseRestoreFile: 'backup:choose-restore-file',
    });
  });

  it('registers a chosen folder with the service using both secrets, and returns only a display name', async () => {
    const { f, calls } = fake(200, { label: 'Backups' });
    const r = await registerChosenPath(f, api, 'destination', 'D:\\Business Backups');
    expect(r).toEqual({ status: 'chosen', label: 'Backups' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4310/internal/backup/destination');
    expect(calls[0]!.init.method).toBe('PUT');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-commercebill-launch-secret']).toBe(api.launchSecret);
    expect(headers['x-commercebill-control-secret']).toBe(api.controlSecret);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ path: 'D:\\Business Backups' });
    expect(JSON.stringify(r)).not.toContain('Business Backups');
  });

  it('registers a chosen restore file and returns an opaque id and the file name, never the path', async () => {
    const { f, calls } = fake(200, {
      sourceId: '11111111-1111-4111-8111-111111111111',
      fileName: 'CommerceBill-x.cbbackup',
    });
    const r = await registerChosenPath(
      f,
      api,
      'restore-source',
      'D:\\private\\CommerceBill-x.cbbackup',
    );
    expect(r).toEqual({
      status: 'chosen',
      label: 'CommerceBill-x.cbbackup',
      sourceId: '11111111-1111-4111-8111-111111111111',
    });
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.stringify(r)).not.toContain('private');
  });

  it('reports a generic failure (no detail, no path) when the service refuses or cannot be reached', async () => {
    expect(
      await registerChosenPath(
        fake(400, { error: { message: 'secret detail' } }).f,
        api,
        'destination',
        'D:\\x',
      ),
    ).toEqual({ status: 'failed' });
    expect(await registerChosenPath(fake(403, {}).f, api, 'restore-source', 'D:\\x')).toEqual({
      status: 'failed',
    });
    expect(
      await registerChosenPath(fake(200, { unexpected: true }).f, api, 'destination', 'D:\\x'),
    ).toEqual({ status: 'failed' });
    expect(
      await registerChosenPath(fake(200, { unexpected: true }).f, api, 'restore-source', 'D:\\x'),
    ).toEqual({ status: 'failed' });
    const boom = (async () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:4310');
    }) as unknown as typeof fetch;
    expect(await registerChosenPath(boom, api, 'destination', 'D:\\x')).toEqual({
      status: 'failed',
    });
  });
});
