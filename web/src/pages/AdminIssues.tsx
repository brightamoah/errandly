import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { Empty, ErrorNote, StatusPill, useAction, when } from '../ui';

export default function AdminIssues() {
  const [filter, setFilter] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [issues, setIssues] = useState<any[] | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const { busy, error, run } = useAction();

  const load = () => api(`/admin/issues?status=${filter}`).then((r) => setIssues(r.issues));
  useEffect(() => { load(); }, [filter]);

  const resolve = (id: number) => run(async () => {
    await api(`/admin/issues/${id}/resolve`, { body: { resolutionNotes: notes[id] ?? '' } });
    await load();
  });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Issues</h1>
        <div className="tabs" role="tablist">
          {(['OPEN', 'RESOLVED'] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'OPEN' ? 'Open' : 'Resolved'}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      {issues?.length === 0 && <Empty>{filter === 'OPEN' ? 'No open issues. Nothing needs review.' : 'No resolved issues yet.'}</Empty>}
      <div className="issue-list">
        {issues?.map((i) => (
          <article key={i.id} className="card issue">
            <header>
              <h2>Issue {i.id} on <Link to={`/orders/${i.order_id}`}>order {i.order_id}</Link></h2>
              <StatusPill status={i.order_status} />
            </header>
            <p className="issue-meta">Reported by {i.reporter_name}, {when(i.created_at)}. Order total {money(i.final_total_minor)}.</p>
            <blockquote>{i.description}</blockquote>
            {i.status === 'OPEN' ? (
              <div className="resolve">
                <label>Resolution notes
                  <textarea rows={2} value={notes[i.id] ?? ''} onChange={(e) => setNotes({ ...notes, [i.id]: e.target.value })} placeholder="What was decided and what happens next" />
                </label>
                <button className="primary" disabled={busy || (notes[i.id] ?? '').trim().length < 5} onClick={() => resolve(i.id)}>Resolve issue</button>
              </div>
            ) : (
              <p className="resolution"><strong>Resolved {when(i.resolved_at)}:</strong> {i.resolution_notes}</p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
