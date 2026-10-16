import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

/** Centralized error boundary: shows a safe message, never stack traces or internals. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Diagnostics logging is wired in a later phase; nothing sensitive is rendered.
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div role="alert" className="p-6">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p>
            The screen could not be displayed. Your saved data was not changed. Please restart the
            application.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
