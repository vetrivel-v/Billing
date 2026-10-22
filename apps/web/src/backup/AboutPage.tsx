import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, LoadingState, PageHeader } from '@commercebill/ui';
import { useState } from 'react';
import { useAuth } from '../auth.js';
import { formatWhen } from './model.js';

function bridge() {
  return typeof window === 'undefined' ? undefined : window.commercebill;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium break-words text-slate-900">{children}</dd>
    </>
  );
}

/** Settings, About & Diagnostics: versions and the state of the local database and service, with the means to hand a support person safe facts. */
export function AboutPage() {
  const { can } = useAuth();
  const desktop = bridge();
  const q = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => desktop!.getDiagnostics(),
    enabled: Boolean(desktop),
    retry: false,
    staleTime: 0,
  });
  const [message, setMessage] = useState<{
    tone: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const d = q.data;
  const run = async (f: () => Promise<{ status: string }>, ok: string, ok2 = 'saved') => {
    setMessage(null);
    try {
      const r = await f();
      if (r.status === ok2 || r.status === 'opened' || r.status === 'shown')
        setMessage({ tone: 'success', text: ok });
      else if (r.status === 'cancelled')
        setMessage({ tone: 'info', text: 'Cancelled. Nothing was saved.' });
      else setMessage({ tone: 'error', text: 'That could not be done. Try again.' });
    } catch {
      setMessage({ tone: 'error', text: 'That could not be done. Try again.' });
    }
  };
  return (
    <>
      <PageHeader
        title="About & Diagnostics"
        description="Versions and the state of CommerceBill's local database and service. Safe to share with whoever supports you."
      />
      {!desktop && <Alert tone="info">Diagnostics are available in the desktop app.</Alert>}
      {desktop && q.isPending && <LoadingState label="Reading diagnostics" />}
      {desktop && q.isError && (
        <Alert tone="error">The diagnostics could not be read. Try again.</Alert>
      )}
      {d && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Versions">
            <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
              <Fact label="CommerceBill">{d.application.version}</Fact>
              <Fact label="Database structure">{d.schema.current ?? 'unknown'}</Fact>
              <Fact label="This version expects">{d.schema.expected ?? 'unknown'}</Fact>
              <Fact label="Structure status">{d.schema.state}</Fact>
              <Fact label="Windows">
                {d.windows.version} ({d.windows.arch})
              </Fact>
            </dl>
          </Card>
          <Card title="State">
            <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
              <Fact label="Database">
                {d.database.running
                  ? `Running on this computer only (127.0.0.1, port ${String(d.database.port)})`
                  : 'Not running'}
              </Fact>
              <Fact label="Local service">{d.api.health}</Fact>
              <Fact label="Last backup check">
                {d.backup.lastVerificationResult
                  ? `${d.backup.lastVerificationResult}${d.backup.lastVerifiedAt ? `, ${formatWhen(d.backup.lastVerifiedAt)}` : ''}`
                  : 'No backup has been verified yet'}
              </Fact>
              <Fact label="Last update">
                {d.lastUpgrade
                  ? `${formatWhen(d.lastUpgrade.at)}${d.lastUpgrade.safetyBackup ? ', with a verified safety backup' : ''}`
                  : 'None'}
              </Fact>
              <Fact label="Free disk space">
                {d.storage.freeMegabytes === null
                  ? 'unknown'
                  : `${String(d.storage.freeMegabytes)} MB`}
              </Fact>
            </dl>
          </Card>
          <Card title="Where things are">
            <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
              <Fact label="Data folder">
                {d.managedDatabase
                  ? d.storage.dataFolder
                  : 'Managed outside CommerceBill (development)'}
              </Fact>
              <Fact label="Log folder">{d.storage.logFolder}</Fact>
            </dl>
            <p className="mt-3 text-sm text-slate-600">
              Logs never contain passwords, passphrases or business details, and old logs are
              removed automatically.
            </p>
          </Card>
          <Card title="Help">
            <div className="space-y-3 text-sm">
              <p className="text-slate-600">
                If CommerceBill isn&apos;t opening, save the diagnostics and send the file to
                whoever supports your installation. It contains no passwords and no business data.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void run(() => desktop!.exportDiagnostics(), 'Diagnostics saved.')}
                >
                  Save diagnostics
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void run(() => desktop!.openLogFolder(), 'The log folder was opened.')
                  }
                >
                  Open log folder
                </Button>
                {d.managedDatabase && can('backup.restore') && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void run(
                        () => desktop!.showSafetyPassphrase(),
                        'Shown in a Windows message box.',
                      )
                    }
                  >
                    Show safety backup passphrase
                  </Button>
                )}
              </div>
              {message && <Alert tone={message.tone}>{message.text}</Alert>}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
