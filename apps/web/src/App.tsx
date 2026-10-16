import { StatusPanel } from './StatusPanel.js';

export function App() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold">CommerceBill Desktop</h1>
        <p className="text-sm opacity-70">
          Phase 0 foundation shell. Billing features arrive in Phase 1.
        </p>
      </header>
      <StatusPanel />
    </main>
  );
}
