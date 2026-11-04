import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, EVENT_LABEL, api, fromMinor, money, newKey, toMinor } from '../api';
import { useAuth } from '../auth';
import { ErrorNote, StatusPill, useAction, when } from '../ui';

const CANCELLABLE = ['SUBMITTED', 'ASSIGNED', 'AWAITING_APPROVAL', 'PROPOSAL_REJECTED', 'APPROVED'];
const ISSUE_REPORTABLE = ['PURCHASED', 'PAID', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'];
const KIND_LABEL: Record<string, string> = { AS_REQUESTED: 'As requested', SUBSTITUTE: 'Swap', UNAVAILABLE: 'Not available' };

export default function OrderDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [order, setOrder] = useState<any>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = () => api(`/orders/${id}`).then(setOrder).catch(setLoadError);
  useEffect(() => { load(); }, [id]);

  if (loadError) return <div className="page"><ErrorNote error={loadError} /><Link to="/orders">Back to orders</Link></div>;
  if (!order) return <div className="page"><p className="lede">Loading order…</p></div>;

  const isOwner = user!.role === 'customer';
  const isAssigned = user!.role === 'shopper' && order.shopper?.id === user!.id;

  return (
    <div className="page detail">
      <div className="detail-main">
        <Link to="/orders" className="back">All orders</Link>
        <div className="detail-head">
          <h1>Order {order.id}</h1>
          <StatusPill status={order.status} />
        </div>
        <p className="lede">
          For {order.customer?.name}, delivering to {order.delivery_address}.
          {order.shopper ? ` Shopper: ${order.shopper.name}.` : ' No shopper yet.'}
        </p>
        {order.notes && <p className="customer-note">“{order.notes}”</p>}

        <section className="next" aria-live="polite">
          {isOwner && <CustomerActions order={order} reload={load} />}
          {user!.role === 'shopper' && <ShopperActions order={order} reload={load} isAssigned={isAssigned} />}
          {user!.role === 'admin' && <p>You're viewing this order as an administrator. Resolve issues from the Issues page.</p>}
        </section>

        {order.issues.length > 0 && (
          <section>
            <h2>Issues</h2>
            {order.issues.map((i: any) => (
              <div key={i.id} className={`issue-row ${i.status.toLowerCase()}`}>
                <p><strong>{i.status === 'OPEN' ? 'Under review' : 'Resolved'}</strong>, reported {when(i.created_at)}</p>
                <p>{i.description}</p>
                {i.resolution_notes && <p className="resolution">Resolution: {i.resolution_notes}</p>}
              </div>
            ))}
          </section>
        )}

        {order.events.length > 0 && (
          <section>
            <h2>History</h2>
            <ol className="timeline">
              {order.events.map((e: any) => (
                <li key={e.id} className={e.type === 'PAYMENT_FAILED' ? 'bad' : ''}>
                  <time dateTime={e.created_at}>{when(e.created_at)}</time>
                  <div>
                    <strong>{EVENT_LABEL[e.type] ?? e.type}</strong>
                    <span>{e.actor_name ?? 'System'}{e.note ? `. ${e.note}` : ''}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <Receipt order={order} />
    </div>
  );
}

/* ------------------------------ Receipt ------------------------------ */

function Receipt({ order }: { order: any }) {
  const p = order.currentProposal;
  const purchase = order.purchase;
  const succeeded = order.payments.find((x: any) => x.status === 'SUCCEEDED');

  return (
    <aside className="receipt" aria-label="Order breakdown">
      <div className="receipt-paper">
        <p className="r-center r-strong">ERRANDLY</p>
        <p className="r-center">Order #{order.id}</p>
        <p className="r-center">{when(order.created_at)}</p>
        <hr />

        {purchase ? (
          <>
            <p className="r-strong">{purchase.store_name}</p>
            <p>Receipt no. {purchase.receipt_number}</p>
            {purchase.receipt_note && <p>{purchase.receipt_note}</p>}
            <hr />
            {purchase.lines.map((l: any) => (
              <div key={l.id} className="r-line">
                <span>{l.quantity} × {l.name}<small>@ {fromMinor(l.unit_price_minor)}</small></span>
                <span>{fromMinor(l.line_total_minor)}</span>
              </div>
            ))}
          </>
        ) : p ? (
          <>
            <p className="r-strong">Proposal v{p.version} {p.status === 'PENDING' ? '(awaiting approval)' : ''}</p>
            {p.lines.map((l: any) => {
              const item = order.items.find((i: any) => i.id === l.order_item_id);
              return (
                <div key={l.id} className={`r-line kind-${l.kind.toLowerCase()}`}>
                  <span>
                    {l.kind === 'UNAVAILABLE' ? item?.name : `${l.quantity} × ${l.name}`}
                    <small>
                      {KIND_LABEL[l.kind]}
                      {l.kind === 'SUBSTITUTE' && ` for ${item?.name}`}
                      {l.kind !== 'UNAVAILABLE' && ` @ ${fromMinor(l.unit_price_minor)}`}
                      {l.note && `. ${l.note}`}
                    </small>
                  </span>
                  <span>{l.kind === 'UNAVAILABLE' ? '—' : fromMinor(l.quantity * l.unit_price_minor)}</span>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <p className="r-strong">Requested</p>
            {order.items.map((i: any) => (
              <div key={i.id} className="r-line">
                <span>{i.quantity} × {i.name}{i.notes && <small>{i.notes}</small>}</span>
                <span>…</span>
              </div>
            ))}
          </>
        )}

        <hr />
        <div className="r-line"><span>Goods</span><span>{fromMinor(purchase?.goods_total_minor ?? p?.goods_total_minor ?? 0)}</span></div>
        <div className="r-line"><span>Service fee</span><span>{fromMinor(order.fee_minor)}</span></div>
        <div className="r-line r-total"><span>{purchase ? 'TOTAL' : p ? 'EST. TOTAL' : 'BUDGET + FEE'}</span>
          <span>{money(purchase?.final_total_minor ?? p?.total_minor ?? order.budget_minor + order.fee_minor)}</span>
        </div>
        <hr />
        <div className="r-line"><span>Goods budget</span><span>{fromMinor(order.budget_minor)}</span></div>
        {p?.approval && (
          <div className="r-line"><span>Approved up to</span><span>{fromMinor(p.approval.approved_amount_minor)}</span></div>
        )}
        {order.payments.map((pay: any) => (
          <div key={pay.id} className={`r-line ${pay.status === 'FAILED' ? 'r-failed' : ''}`}>
            <span>Payment {pay.status === 'SUCCEEDED' ? 'OK' : 'DECLINED'}<small>{when(pay.created_at)}</small></span>
            <span>{fromMinor(pay.amount_minor)}</span>
          </div>
        ))}
        {succeeded && <p className="r-center r-stamp">PAID</p>}
        <p className="r-center r-small">Simulated payments. No real money moves.</p>
      </div>
    </aside>
  );
}

/* ------------------------------ Customer ----------------------------- */

function CustomerActions({ order, reload }: { order: any; reload: () => void }) {
  const a = useAction();
  const [reason, setReason] = useState('');
  const [issue, setIssue] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const payKey = useRef(newKey());
  const p = order.currentProposal;

  const act = (fn: () => Promise<unknown>) => a.run(async () => { await fn(); await reload(); });

  const pay = (outcome: 'success' | 'failure') => a.run(async () => {
    try {
      await api(`/orders/${order.id}/payments`, { body: { outcome }, idempotencyKey: payKey.current });
      payKey.current = newKey();
    } catch (e) {
      // The server answered, so this attempt is settled; a network failure keeps the key for a safe retry.
      if (e instanceof ApiError) payKey.current = newKey();
      throw e;
    } finally {
      await reload();
    }
  });

  const lastPayment = order.payments.at(-1);

  return (
    <>
      {order.status === 'SUBMITTED' && <p>Your order is waiting for a shopper to accept it.</p>}
      {order.status === 'ASSIGNED' && <p>{order.shopper.name} is checking prices and will send you a proposal.</p>}
      {order.status === 'PROPOSAL_REJECTED' && <p>You rejected the proposal. {order.shopper.name} can send a revised one, or you can cancel.</p>}
      {order.status === 'APPROVED' && <p>Approved. {order.shopper.name} is buying your items now and can't spend more than {money(p.approval.approved_amount_minor)}.</p>}

      {order.status === 'AWAITING_APPROVAL' && (
        <div className="decision">
          <h2>Approve this proposal?</h2>
          <p>
            {order.shopper.name} proposes {money(p.total_minor)} including the fee
            {p.goods_total_minor > order.budget_minor && <>, which is {money(p.goods_total_minor - order.budget_minor)} over your goods budget</>}
            {p.lines.some((l: any) => l.kind === 'SUBSTITUTE') && <>, with swaps marked on the receipt</>}.
            Nothing is bought until you approve.
          </p>
          <div className="buttons">
            <button className="primary" disabled={a.busy} onClick={() => act(() => api(`/orders/${order.id}/proposals/${p.id}/approve`, { body: { version: p.version } }))}>
              Approve {money(p.total_minor)}
            </button>
          </div>
          <label>Or tell the shopper what to change
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No swap for the rice, skip it instead" />
          </label>
          <button className="secondary" disabled={a.busy} onClick={() => act(() => api(`/orders/${order.id}/proposals/${p.id}/reject`, { body: reason ? { reason } : {} }))}>
            Reject proposal
          </button>
        </div>
      )}

      {order.status === 'PURCHASED' && (
        <div className="decision">
          <h2>Pay {money(order.final_total_minor)}</h2>
          <p>Your items are bought. The shopper can set off once payment goes through.</p>
          {lastPayment?.status === 'FAILED' && <p className="warn">Your last payment was declined. Try again.</p>}
          <div className="buttons">
            <button className="primary" disabled={a.busy} onClick={() => pay('success')}>Pay now</button>
            <button className="secondary" disabled={a.busy} onClick={() => pay('failure')}>Simulate a declined payment</button>
          </div>
        </div>
      )}

      {order.status === 'PAID' && <p>Payment received. {order.shopper.name} will head out shortly.</p>}
      {order.status === 'OUT_FOR_DELIVERY' && <p>{order.shopper.name} is on the way.</p>}

      {order.status === 'DELIVERED' && (
        <div className="decision">
          <h2>Got everything?</h2>
          <p>Confirm you've received your items to complete the order. If something's wrong, report an issue below instead.</p>
          <button className="primary" disabled={a.busy} onClick={() => act(() => api(`/orders/${order.id}/confirm-receipt`, { method: 'POST' }))}>Confirm receipt</button>
        </div>
      )}
      {order.status === 'COMPLETED' && <p>Order complete. Thanks for shopping with Errandly.</p>}
      {order.status === 'CANCELLED' && <p>This order was cancelled. Nothing was bought and you were not charged.</p>}

      {CANCELLABLE.includes(order.status) && (
        <div className="cancel-zone">
          {confirmCancel ? (
            <>
              <span>Cancel this order? Nothing has been bought, so there's no charge.</span>
              <button className="danger" disabled={a.busy} onClick={() => act(() => api(`/orders/${order.id}/cancel`, { body: {} }))}>Yes, cancel order</button>
              <button className="ghost" onClick={() => setConfirmCancel(false)}>Keep order</button>
            </>
          ) : (
            <button className="link" onClick={() => setConfirmCancel(true)}>Cancel order</button>
          )}
        </div>
      )}

      {ISSUE_REPORTABLE.includes(order.status) && (
        <details className="report">
          <summary>Report a problem with this order</summary>
          <p>Items have been bought, so the order can't be cancelled. An administrator will review what you send.</p>
          <textarea rows={3} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="What went wrong?" />
          <button className="secondary" disabled={a.busy || issue.trim().length < 5}
            onClick={() => act(async () => { await api(`/orders/${order.id}/issues`, { body: { description: issue } }); setIssue(''); })}>
            Send report
          </button>
        </details>
      )}
      <ErrorNote error={a.error} />
    </>
  );
}

/* ------------------------------ Shopper ------------------------------ */

function ShopperActions({ order, reload, isAssigned }: { order: any; reload: () => void; isAssigned: boolean }) {
  const a = useAction();
  const [revising, setRevising] = useState(false);
  const act = (fn: () => Promise<unknown>) => a.run(async () => { await fn(); await reload(); });

  if (!isAssigned) {
    if (order.status !== 'SUBMITTED') return <p>This order is assigned to another shopper.</p>;
    return (
      <div className="decision">
        <h2>Take this job?</h2>
        <p>You'll earn {money(order.fee_minor)}. Goods budget is {money(order.budget_minor)}.</p>
        <button className="primary" disabled={a.busy} onClick={() => act(() => api(`/orders/${order.id}/accept`, { method: 'POST' }))}>Accept job</button>
        <ErrorNote error={a.error} />
      </div>
    );
  }

  const s = order.status;
  return (
    <>
      {(s === 'ASSIGNED' || s === 'PROPOSAL_REJECTED' || (s === 'AWAITING_APPROVAL' && revising) || (s === 'APPROVED' && revising)) && (
        <ProposalForm order={order} onDone={() => { setRevising(false); reload(); }} />
      )}
      {s === 'AWAITING_APPROVAL' && !revising && (
        <div className="decision">
          <h2>Waiting for {order.customer.name}</h2>
          <p>Your proposal has swaps or goes over budget, so the customer must approve it before you buy anything.</p>
          <button className="link" onClick={() => setRevising(true)}>Revise proposal</button>
        </div>
      )}
      {s === 'APPROVED' && !revising && (
        <>
          <PurchaseForm order={order} onDone={reload} />
          <button className="link" onClick={() => setRevising(true)}>Change the proposal instead (needs fresh approval)</button>
        </>
      )}
      {s === 'PURCHASED' && <p>Waiting for {order.customer.name} to pay {money(order.final_total_minor)}. You can set off once payment succeeds.</p>}
      {s === 'PAID' && (
        <div className="decision">
          <h2>Payment received</h2>
          <button className="primary" disabled={a.busy} onClick={() => act(() => api(`/orders/${order.id}/out-for-delivery`, { method: 'POST' }))}>Set off for delivery</button>
        </div>
      )}
      {s === 'OUT_FOR_DELIVERY' && (
        <div className="decision">
          <h2>Delivering to {order.delivery_address}</h2>
          <button className="primary" disabled={a.busy} onClick={() => act(() => api(`/orders/${order.id}/delivered`, { method: 'POST' }))}>Mark as delivered</button>
        </div>
      )}
      {s === 'DELIVERED' && <p>Delivered. Waiting for {order.customer.name} to confirm receipt.</p>}
      {s === 'COMPLETED' && <p>Job complete.</p>}
      {s === 'CANCELLED' && <p>The customer cancelled this order.</p>}
      <ErrorNote error={a.error} />
    </>
  );
}

function ProposalForm({ order, onDone }: { order: any; onDone: () => void }) {
  const prev = order.currentProposal?.lines ?? [];
  const [lines, setLines] = useState(() =>
    order.items.map((i: any) => {
      const old = prev.find((l: any) => l.order_item_id === i.id);
      return {
        orderItemId: i.id,
        kind: old?.kind ?? 'AS_REQUESTED',
        name: old?.kind === 'SUBSTITUTE' ? old.name : '',
        quantity: String(old?.quantity || i.quantity),
        price: old && old.kind !== 'UNAVAILABLE' ? fromMinor(old.unit_price_minor) : '',
      };
    }),
  );
  const a = useAction();
  const update = (n: number, patch: object) => setLines(lines.map((l: any, i: number) => (i === n ? { ...l, ...patch } : l)));

  const goods = lines.reduce((s: number, l: any) => s + (l.kind === 'UNAVAILABLE' ? 0 : Number(l.quantity || 0) * toMinor(l.price)), 0);
  const needsApproval = goods > order.budget_minor || lines.some((l: any) => l.kind === 'SUBSTITUTE');
  const rejected = order.proposalHistory.length > 0 && order.status === 'PROPOSAL_REJECTED';
  const lastReason = rejected ? order.events.filter((e: any) => e.type === 'PROPOSAL_REJECTED').at(-1)?.note : null;

  const submit = () => a.run(async () => {
    await api(`/orders/${order.id}/proposals`, {
      body: {
        lines: lines.map((l: any) => ({
          orderItemId: l.orderItemId,
          kind: l.kind,
          ...(l.kind === 'SUBSTITUTE' ? { name: l.name } : {}),
          quantity: l.kind === 'UNAVAILABLE' ? 0 : Number(l.quantity),
          unitPriceMinor: l.kind === 'UNAVAILABLE' ? 0 : toMinor(l.price),
        })),
      },
    });
    onDone();
  });

  return (
    <div className="decision">
      <h2>{order.proposalHistory.length ? 'Revise your proposal' : 'Price the list'}</h2>
      {lastReason && <p className="warn">Customer's feedback: {lastReason}</p>}
      <p>Enter shelf prices. Mark swaps and anything you can't find.</p>
      <div className="proposal-table">
        {order.items.map((item: any, n: number) => {
          const l = lines[n];
          return (
            <fieldset key={item.id} className={`p-row kind-${l.kind.toLowerCase()}`}>
              <legend>{item.quantity} × {item.name}{item.notes && <small> ({item.notes})</small>}</legend>
              <select aria-label="Availability" value={l.kind} onChange={(e) => update(n, { kind: e.target.value })}>
                <option value="AS_REQUESTED">Found it</option>
                <option value="SUBSTITUTE">Swap for…</option>
                <option value="UNAVAILABLE">Not available</option>
              </select>
              {l.kind === 'SUBSTITUTE' && (
                <input aria-label="Substitute product" placeholder="Substitute product" value={l.name} onChange={(e) => update(n, { name: e.target.value })} />
              )}
              {l.kind !== 'UNAVAILABLE' && (
                <>
                  <input aria-label="Quantity" type="number" min={1} className="num" value={l.quantity} onChange={(e) => update(n, { quantity: e.target.value })} />
                  <input aria-label="Unit price" type="number" min={0} step="0.01" inputMode="decimal" placeholder="Unit price" className="num" value={l.price} onChange={(e) => update(n, { price: e.target.value })} />
                </>
              )}
            </fieldset>
          );
        })}
      </div>
      <p className="estimate">
        Goods {money(goods)} of {money(order.budget_minor)} budget.{' '}
        {needsApproval ? <strong>The customer will need to approve this before you buy.</strong> : 'Within budget with no swaps, so you can buy straight away.'}
      </p>
      <ErrorNote error={a.error} />
      <button className="primary" disabled={a.busy} onClick={submit}>{needsApproval ? 'Send for approval' : 'Confirm and start shopping'}</button>
    </div>
  );
}

function PurchaseForm({ order, onDone }: { order: any; onDone: () => void }) {
  const p = order.currentProposal;
  const buyable = p.lines.filter((l: any) => l.kind !== 'UNAVAILABLE');
  const [store, setStore] = useState('');
  const [receiptNo, setReceiptNo] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState(buyable.map((l: any) => ({ id: l.id, quantity: String(l.quantity), price: fromMinor(l.unit_price_minor), max: l.quantity, name: l.name })));
  const a = useAction();

  const goods = lines.reduce((s: number, l: any) => s + Number(l.quantity || 0) * toMinor(l.price), 0);
  const total = goods + order.fee_minor;
  const limit = p.approval.approved_amount_minor;

  const submit = () => a.run(async () => {
    await api(`/orders/${order.id}/purchase`, {
      body: {
        storeName: store,
        receiptNumber: receiptNo,
        ...(note ? { receiptNote: note } : {}),
        lines: lines.filter((l: any) => Number(l.quantity) > 0).map((l: any) => ({ proposalLineId: l.id, quantity: Number(l.quantity), unitPriceMinor: toMinor(l.price) })),
      },
    });
    onDone();
  });

  return (
    <div className="decision">
      <h2>Record what you bought</h2>
      <p>Enter what's on the receipt. The total can't go over {money(limit)}.</p>
      <div className="form-grid">
        <label>Store<input value={store} onChange={(e) => setStore(e.target.value)} placeholder="e.g. Makola Market" /></label>
        <label>Receipt number<input value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} /></label>
      </div>
      <div className="proposal-table">
        {lines.map((l: any, n: number) => (
          <fieldset key={l.id} className="p-row">
            <legend>{l.name}</legend>
            <input aria-label="Quantity bought" type="number" min={0} max={l.max} className="num" value={l.quantity}
              onChange={(e) => setLines(lines.map((x: any, i: number) => (i === n ? { ...x, quantity: e.target.value } : x)))} />
            <input aria-label="Price paid each" type="number" min={0} step="0.01" className="num" value={l.price}
              onChange={(e) => setLines(lines.map((x: any, i: number) => (i === n ? { ...x, price: e.target.value } : x)))} />
          </fieldset>
        ))}
      </div>
      <label>Receipt note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></label>
      <p className={`estimate ${total > limit ? 'over' : ''}`}>
        Total {money(total)} including fee. {total > limit ? `That's ${money(total - limit)} over what the customer approved; send a revised proposal instead.` : `Within the ${money(limit)} approved.`}
      </p>
      <ErrorNote error={a.error} />
      <button className="primary" disabled={a.busy || !store || !receiptNo} onClick={submit}>Save purchase</button>
    </div>
  );
}
