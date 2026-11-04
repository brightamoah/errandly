import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, newKey, toMinor } from '../api';
import { Empty, ErrorNote, useAction } from '../ui';
import { PRODUCTS } from '../products';

interface Item { id: number; name: string; quantity: number; notes: string | null }

export default function Cart() {
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState({ name: '', quantity: '1', notes: '' });
  const [search, setSearch] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [order, setOrder] = useState({ budget: '', address: '', notes: '' });
  const [fee, setFee] = useState(0);
  const submitKey = useRef(newKey());
  const add = useAction();
  const submit = useAction();
  const navigate = useNavigate();
  const dropdownRef = useRef<HTMLLabelElement>(null);

  const load = () => api('/cart').then((r) => setItems(r.items));
  useEffect(() => { load(); api('/config').then((c) => setFee(c.serviceFeeMinor)); }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PRODUCTS;
    return PRODUCTS.filter((p) => p.toLowerCase().includes(q));
  }, [search]);

  const selectProduct = (product: string) => {
    setDraft({ ...draft, name: product });
    setSearch('');
    setDropdownOpen(false);
  };

  const addItem = (e: FormEvent) => {
    e.preventDefault();
    add.run(async () => {
      await api('/cart/items', { body: { name: draft.name, quantity: Number(draft.quantity), ...(draft.notes ? { notes: draft.notes } : {}) } });
      setDraft({ name: '', quantity: '1', notes: '' });
      await load();
    });
  };

  const setQty = (item: Item, quantity: number) => add.run(async () => {
    if (quantity < 1) await api(`/cart/items/${item.id}`, { method: 'DELETE' });
    else await api(`/cart/items/${item.id}`, { method: 'PATCH', body: { quantity } });
    await load();
  });

  const placeOrder = (e: FormEvent) => {
    e.preventDefault();
    submit.run(async () => {
      const created = await api('/orders', {
        body: { budgetMinor: toMinor(order.budget), deliveryAddress: order.address, ...(order.notes ? { notes: order.notes } : {}) },
        idempotencyKey: submitKey.current,
      });
      submitKey.current = newKey();
      navigate(`/orders/${created.id}`);
    });
  };

  const budgetMinor = toMinor(order.budget);

  return (
    <div className="page cart-page">
      <section>
        <h1>Shopping list</h1>
        <p className="lede">Add everything you need. Your shopper will price it at the market and check any swaps with you.</p>

        <form className="add-row" onSubmit={addItem}>
          <label className="grow" style={{ position: 'relative' }} ref={dropdownRef}>
            Item
            <input
              required
              placeholder="Search products…"
              value={draft.name}
              onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setSearch(e.target.value); setDropdownOpen(true); }}
              onFocus={() => setDropdownOpen(true)}
              autoComplete="off"
            />
            {dropdownOpen && (
              <div
                className="dropdown-menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  maxHeight: '240px',
                  overflowY: 'auto',
                  background: '#fff',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  zIndex: 100,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                }}
              >
                <div style={{ padding: '6px 10px', borderBottom: '1px solid #eee', position: 'sticky', top: 0, background: '#fff' }}>
                  <input
                    placeholder="Search…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ width: '100%', padding: '4px 6px', fontSize: '0.9em' }}
                    autoFocus
                  />
                </div>
                {filteredProducts.length === 0 ? (
                  <div style={{ padding: '8px 10px', color: '#888', fontStyle: 'italic' }}>No products found</div>
                ) : (
                  filteredProducts.map((p) => (
                    <div
                      key={p}
                      onClick={() => selectProduct(p)}
                      style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid #f5f5f5' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '#fff')}
                    >
                      {p}
                    </div>
                  ))
                )}
              </div>
            )}
          </label>
          <label className="qty">Qty<input type="number" min={1} max={999} required value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} /></label>
          <label className="grow">Note for shopper<input placeholder="Optional" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
          <button className="primary" disabled={add.busy}>Add</button>
        </form>
        <ErrorNote error={add.error} />

        {items.length === 0 ? (
          <Empty>Your list is empty. Add the first item above.</Empty>
        ) : (
          <ul className="list-items">
            {items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  {item.notes && <small>{item.notes}</small>}
                </div>
                <div className="stepper" aria-label={`Quantity of ${item.name}`}>
                  <button className="ghost" onClick={() => setQty(item, item.quantity - 1)} aria-label="Decrease">−</button>
                  <span>{item.quantity}</span>
                  <button className="ghost" onClick={() => setQty(item, item.quantity + 1)} aria-label="Increase">+</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside>
        <form className="card" onSubmit={placeOrder}>
          <h2>Send to a shopper</h2>
          <label>Spending limit for goods ({money(0).split(' ')[0]})
            <input type="number" min="0.01" step="0.01" required inputMode="decimal" value={order.budget} onChange={(e) => setOrder({ ...order, budget: e.target.value })} />
            <small>Anything over this, or any swap, needs your approval before the shopper buys.</small>
          </label>
          <label>Deliver to<textarea required minLength={5} rows={2} value={order.address} onChange={(e) => setOrder({ ...order, address: e.target.value })} /></label>
          <label>Anything else?<textarea rows={2} placeholder="Optional" value={order.notes} onChange={(e) => setOrder({ ...order, notes: e.target.value })} /></label>
          <dl className="sums">
            <div><dt>Goods up to</dt><dd>{money(budgetMinor)}</dd></div>
            <div><dt>Service fee</dt><dd>{money(fee)}</dd></div>
            <div className="total"><dt>Most you'll pay</dt><dd>{money(budgetMinor + fee)}</dd></div>
          </dl>
          <ErrorNote error={submit.error} />
          <button className="primary wide" disabled={submit.busy || items.length === 0}>Place order</button>
        </form>
      </aside>
    </div>
  );
}