import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { db } from '../src/db';

export const app = createApp();
export const api = () => request(app);
export const FEE = 1500;

export async function resetDb() {
  await db.migrate.latest();
  await db.raw(
    'TRUNCATE order_events, issues, payments, purchase_lines, purchases, approvals, proposal_lines, proposals, order_items, orders, cart_items, users RESTART IDENTITY CASCADE',
  );
}

export interface TestUser {
  id: number;
  token: string;
  auth: { Authorization: string };
}

let counter = 0;
export async function register(role: 'customer' | 'shopper'): Promise<TestUser> {
  counter += 1;
  const res = await api()
    .post('/api/auth/register')
    .send({ email: `${role}${counter}-${Date.now()}@test.dev`, password: 'Password123', name: `${role} ${counter}`, role });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, token: res.body.token, auth: { Authorization: `Bearer ${res.body.token}` } };
}

export async function admin(): Promise<TestUser> {
  const bcrypt = await import('bcryptjs');
  const email = `admin-${Date.now()}@test.dev`;
  await db('users').insert({ email, name: 'Admin', role: 'admin', password_hash: await bcrypt.hash('Password123', 4) });
  const res = await api().post('/api/auth/login').send({ email, password: 'Password123' });
  return { id: res.body.user.id, token: res.body.token, auth: { Authorization: `Bearer ${res.body.token}` } };
}

export const key = () => crypto.randomUUID();

/** Customer fills cart with the given items and submits an order. Returns the order body. */
export async function placeOrder(
  customer: TestUser,
  items: { name: string; quantity: number }[] = [
    { name: 'Rice', quantity: 1 },
    { name: 'Eggs', quantity: 2 },
    { name: 'Milk', quantity: 3 },
  ],
  budgetMinor = 10000,
) {
  for (const item of items) {
    await api().post('/api/cart/items').set(customer.auth).send(item).expect(201);
  }
  const res = await api()
    .post('/api/orders')
    .set(customer.auth)
    .set('Idempotency-Key', key())
    .send({ budgetMinor, deliveryAddress: '12 Oxford Street, Osu, Accra' })
    .expect(201);
  return res.body;
}

/** Proposal with every item as requested at the given unit price. */
export function asRequested(order: { items: { id: number; quantity: number }[] }, unitPriceMinor = 1000) {
  return order.items.map((i) => ({ orderItemId: i.id, kind: 'AS_REQUESTED', quantity: i.quantity, unitPriceMinor }));
}

/** Purchase every proposal line at its proposed price. */
export function buyAll(order: { currentProposal: { lines: { id: number; quantity: number; unit_price_minor: number; kind: string }[] } }) {
  return {
    storeName: 'Max Mart',
    receiptNumber: 'R-1001',
    lines: order.currentProposal.lines
      .filter((l) => l.kind !== 'UNAVAILABLE')
      .map((l) => ({ proposalLineId: l.id, quantity: l.quantity, unitPriceMinor: l.unit_price_minor })),
  };
}

export { db };
