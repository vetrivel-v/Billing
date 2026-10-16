// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusPanel } from './StatusPanel.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StatusPanel />
    </QueryClientProvider>,
  );
}

describe('StatusPanel', () => {
  it('shows API and database status from the health endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const db = url.endsWith('/health/db');
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.0.1', database: { status: 'ok' }, db }),
          { status: 200 },
        );
      }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('api-status').textContent).toBe('ok'));
    await waitFor(() => expect(screen.getByTestId('db-status').textContent).toBe('ok'));
  });

  it('shows Unreachable when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('api-status').textContent).toBe('Unreachable'));
  });
});
