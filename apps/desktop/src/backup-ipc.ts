/**
 * The IPC contract for backup folder and restore-file choosers (Task 1.17), free of Electron imports so it is unit-testable.
 *
 * The renderer asks for exactly two things, with NO argument: `backup:choose-destination` and `backup:choose-restore-file`. The main
 * process opens the operating system dialog itself, then registers the chosen path with the local service through routes that need
 * the shell's own control secret (which the renderer never has). The renderer is told only a display name (and, for a restore file,
 * an opaque id): no path ever crosses back, and the renderer cannot make the service write or read anywhere on its own.
 */
import type { BackupChoiceResult } from '@commercebill/shared-types';

export const BACKUP_CHANNELS = {
  chooseDestination: 'backup:choose-destination',
  chooseRestoreFile: 'backup:choose-restore-file',
} as const;

export interface ApiEndpoint {
  baseUrl: string;
  launchSecret: string;
  controlSecret: string;
}

export async function registerChosenPath(
  fetchFn: typeof fetch,
  api: ApiEndpoint,
  kind: 'destination' | 'restore-source',
  chosenPath: string,
): Promise<BackupChoiceResult> {
  try {
    const res = await fetchFn(`${api.baseUrl}/internal/backup/${kind}`, {
      method: kind === 'destination' ? 'PUT' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-commercebill-launch-secret': api.launchSecret,
        'x-commercebill-control-secret': api.controlSecret,
      },
      body: JSON.stringify({ path: chosenPath }),
    });
    if (!res.ok) return { status: 'failed' };
    const body = (await res.json()) as { label?: string; sourceId?: string; fileName?: string };
    if (kind === 'destination')
      return typeof body.label === 'string'
        ? { status: 'chosen', label: body.label }
        : { status: 'failed' };
    return typeof body.sourceId === 'string' && typeof body.fileName === 'string'
      ? { status: 'chosen', label: body.fileName, sourceId: body.sourceId }
      : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
