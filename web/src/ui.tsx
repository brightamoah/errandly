import { ReactNode, useState } from 'react';
import { ApiError, STATUS_LABEL } from './api';

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status.toLowerCase()}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ApiError && Array.isArray(error.details)
    ? (error.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`)
    : [];
  return (
    <div className="error" role="alert">
      {message}
      {details.length > 0 && <ul>{details.map((d) => <li key={d}>{d}</li>)}</ul>}
    </div>
  );
}

/** Runs an async action with busy and error state, so every button gets the same behaviour. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function when(date: string) {
  return new Date(date).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
