import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './index.css';

// Sentry — only initializes if VITE_SENTRY_DSN is set. Local dev
// without the env var stays a no-op, no network noise. The
// existing ErrorBoundary in App.tsx still catches render crashes;
// Sentry's `BrowserTracing` adds async error capture + breadcrumbs.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: (import.meta.env.VITE_SENTRY_ENV as string | undefined) ?? import.meta.env.MODE,
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES ?? 0.1),
    // Replays are heavy; opt-in via env when investigating a tricky
    // bug. Off by default to keep bandwidth low for the demo audience.
    replaysSessionSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS ?? 0),
    replaysOnErrorSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS_ON_ERROR ?? 0),
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
