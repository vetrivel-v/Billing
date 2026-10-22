import { Card, PageHeader } from '@commercebill/ui';
import { Link } from 'react-router';
import { useAuth } from '../auth.js';

const link =
  'font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

/** Settings landing: the places where business-wide settings live. */
export function SettingsPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Settings" description="Business-wide settings and safeguards." />
      <div className="grid gap-4 xl:grid-cols-2">
        {can('backup.history.read') && (
          <Card title="Backup & Recovery">
            <p className="mb-2 text-sm text-slate-600">
              Create encrypted backups, check that they can be restored, and recover your data.
            </p>
            <Link to="/settings/backup" className={link}>
              Open Backup & Recovery
            </Link>
          </Card>
        )}
        {can('tax.config.read') && (
          <Card title="Tax configuration">
            <p className="mb-2 text-sm text-slate-600">
              Tax review, seller registration and the billing mode.
            </p>
            <Link to="/tax" className={link}>
              Open Tax
            </Link>
          </Card>
        )}
      </div>
    </>
  );
}
