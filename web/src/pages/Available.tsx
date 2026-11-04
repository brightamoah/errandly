import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { Empty, ErrorNote, useAction, when } from '../ui';

export default function Available() {
  const [orders, setOrders] = useState<any[] | null>(null);
  const { busy, error, run } = useAction();
  const navigate = useNavigate();

  const load = () => api('/orders/available').then((r) => setOrders(r.orders));
  useEffect(() => { load(); }, []);

  const accept = (id: number) => run(async () => {
    try {
      await api(`/orders/${id}/accept`, { method: 'POST' });
      navigate(`/orders/${id}`);
    } catch (e) {
      await load(); // someone else may have taken it; refresh the list
      throw e;
    }
  });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Open requests</h1>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>
      <ErrorNote error={error} />
      {orders && orders.length === 0 && <Empty>No open requests right now. Check back soon.</Empty>}
      <div className="request-grid">
        {orders?.map((o) => (
          <article key={o.id} className="request">
            <header>
              <h2>Order {o.id}</h2>
              <span>{when(o.created_at)}</span>
            </header>
            <ul>
              {o.items.map((i: any) => (
                <li key={i.id}><span>{i.quantity}×</span> {i.name}{i.notes && <small>{i.notes}</small>}</li>
              ))}
            </ul>
            <p className="request-where">{o.delivery_address}</p>
            <footer>
              <span>Budget {money(o.budget_minor)}<small>You earn {money(o.fee_minor)}</small></span>
              <button className="primary" disabled={busy} onClick={() => accept(o.id)}>Accept job</button>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}
