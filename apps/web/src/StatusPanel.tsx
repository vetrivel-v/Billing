import { useQuery } from '@tanstack/react-query';
import { fetchDbHealth, fetchHealth } from './api.js';

export function StatusPanel() {
  const api = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });
  const db = useQuery({ queryKey: ['health', 'db'], queryFn: fetchDbHealth, retry: false });

  return (
    <section aria-label="System status" className="rounded border p-4">
      <h2 className="mb-2 text-lg font-medium">System status</h2>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt>API</dt>
        <dd data-testid="api-status">
          {api.isPending ? 'Checking...' : api.isError ? 'Unreachable' : api.data.status}
        </dd>
        <dt>Database</dt>
        <dd data-testid="db-status">
          {db.isPending ? 'Checking...' : db.isError ? 'Unreachable' : db.data.database.status}
        </dd>
        <dt>Version</dt>
        <dd>{api.data?.version ?? '-'}</dd>
      </dl>
    </section>
  );
}
