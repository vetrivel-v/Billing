import { useQuery } from '@tanstack/react-query';
import { Card } from '@commercebill/ui';
import { ApiRequestError, fetchDbHealth, fetchHealth } from './api.js';

function describeFailure(error: unknown): string {
  return error instanceof ApiRequestError && error.status === 401
    ? 'Not authorised'
    : 'Unreachable';
}

export function StatusPanel() {
  const api = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });
  const db = useQuery({ queryKey: ['health', 'db'], queryFn: fetchDbHealth, retry: false });

  return (
    <Card title="System status">
      <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm font-medium text-slate-900 [&>dt]:font-normal [&>dt]:text-slate-500">
        <dt>API</dt>
        <dd data-testid="api-status">
          {api.isPending
            ? 'Checking...'
            : api.isError
              ? describeFailure(api.error)
              : api.data.status}
        </dd>
        <dt>Database</dt>
        <dd data-testid="db-status">
          {db.isPending
            ? 'Checking...'
            : db.isError
              ? describeFailure(db.error)
              : db.data.database.status}
        </dd>
        <dt>Version</dt>
        <dd>{api.data?.version ?? '-'}</dd>
      </dl>
    </Card>
  );
}
