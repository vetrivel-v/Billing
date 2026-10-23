import { Card, CardGrid, PageHeader } from '@commercebill/ui';
import { Link } from 'react-router';
import { useAuth } from '../auth.js';

const link =
  'font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600';

interface Entry {
  to: string;
  name: string;
  description: string;
  /** Permission needed to open it; none = any person who can open Settings. */
  permission?: string;
}

/** Only areas that exist today. A group with nothing the person may open is not shown. */
const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: 'Business',
    entries: [
      {
        to: '/settings/business',
        name: 'Business Profile',
        description: 'Legal name, GST registration (GSTIN) and your place of business.',
        permission: 'org.settings.read',
      },
    ],
  },
  {
    title: 'Tax',
    entries: [
      {
        to: '/tax',
        name: 'Tax Configuration',
        description: 'Tax review, production readiness and the billing mode.',
        permission: 'tax.config.read',
      },
      {
        to: '/tax/hsn-sac',
        name: 'HSN / SAC',
        description: 'The HSN and SAC codes used on invoice lines.',
        permission: 'tax.config.read',
      },
    ],
  },
  {
    title: 'Data protection',
    entries: [
      {
        to: '/settings/backup',
        name: 'Backup & Recovery',
        description: 'Encrypted backups, restore checks and recovery.',
        permission: 'backup.history.read',
      },
    ],
  },
  {
    title: 'System',
    entries: [
      {
        to: '/settings/about',
        name: 'About & Diagnostics',
        description: 'Versions, the state of the local database and service, support diagnostics.',
      },
    ],
  },
];

/** Settings landing: a compact index of the places where business-wide settings live. */
export function SettingsPage() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Settings" description="Business-wide settings and safeguards." />
      <CardGrid>
        {GROUPS.map((g) => {
          const entries = g.entries.filter((e) => !e.permission || can(e.permission));
          if (entries.length === 0) return null;
          return (
            <Card key={g.title} title={g.title}>
              <ul className="divide-y divide-slate-100">
                {entries.map((e) => (
                  <li key={e.to} className="py-2 first:pt-0 last:pb-0">
                    <Link to={e.to} className={link}>
                      {e.name}
                    </Link>
                    <p className="text-sm text-slate-600">{e.description}</p>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </CardGrid>
    </>
  );
}
