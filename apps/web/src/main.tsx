import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { App } from './App.js';
import { AuthProvider } from './auth.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import './index.css';

const queryClient = new QueryClient();
const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

// HashRouter works from file://, from the app:// protocol and from the dev server without server-side rewrites.
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </HashRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
