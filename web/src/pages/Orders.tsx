import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { Empty, StatusPill, when } from '../ui';

const YOUR_MOVE: Record<string, string[]> = {
  customer: ['AWAITING_APPROVAL', 'PURCHASED', 'DELIVERED'],
  shopper: ['ASSIGNED', 'PROPOSAL_REJECTED', 'APPROVED', 'PAID', 'OUT_FOR_DELIVERY'],
  admin: [],
};

export default function Orders() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<any[] | null>(null);
  useEffect(() => { api('/orders').then((r) => setOrders(r.orders)); }, []);

  const title = { customer: 'My orders', shopper: 'My jobs', admin: 'All orders' }[user!.role];

  return (
    <div className="page">
      <h1>{title}</h1>
      {orders && orders.length === 0 && (
        <Empty>
          {user!.role === 'customer' && <>No orders yet. <Link to="/cart">Start a shopping list</Link>.</>}
          {user!.role === 'shopper' && <>No jobs yet. <Link to="/available">Pick up an open request</Link>.</>}
          {user!.role === 'admin' && <>No orders have been placed.</>}
        </Empty>
      )}
      <ul className="order-list">
        {orders?.map((o) => {
          const yourMove = YOUR_MOVE[user!.role].includes(o.status);
          return (
            <li key={o.id} className={yourMove ? 'your-move' : ''}>
              <Link to={`/orders/${o.id}`}>
                <span className="order-no">Order {o.id}</span>
                <span className="order-meta">
                  {o.item_count} {o.item_count === 1 ? 'item' : 'items'}, placed {when(o.created_at)}
                  {user!.role !== 'customer' && <> for {o.customer_name}</>}
                  {user!.role !== 'shopper' && o.shopper_name && <>, shopper {o.shopper_name}</>}
                </span>
                <span className="order-amount">{o.final_total_minor != null ? money(o.final_total_minor) : `up to ${money(o.budget_minor + o.fee_minor)}`}</span>
                <span className="order-status">
                  <StatusPill status={o.status} />
                  {yourMove && <em>Your move</em>}
                  {o.has_open_issue && <em className="issue-flag">Open issue</em>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
