/**
 * The six acceptance scenarios from the project brief, one test each.
 */
import { api, asRequested, buyAll, db, FEE, key, placeOrder, register, resetDb } from './helpers';

beforeAll(resetDb);
afterAll(() => db.destroy());

test('AS-1: three items, fulfilled, paid, confirmed → completed with correct total and history', async () => {
  const customer = await register('customer');
  const shopper = await register('shopper');
  const order = await placeOrder(customer);
  expect(order.status).toBe('SUBMITTED');
  expect(order.items).toHaveLength(3);

  await api().post(`/api/orders/${order.id}/accept`).set(shopper.auth).expect(200);

  // Rice 1×1200 + Eggs 2×900 + Milk 3×500 = 4500 goods, within budget, no substitutes → auto-approved
  const prices = [1200, 900, 500];
  const lines = order.items.map((i: { id: number; quantity: number }, n: number) => ({
    orderItemId: i.id, kind: 'AS_REQUESTED', quantity: i.quantity, unitPriceMinor: prices[n],
  }));
  const proposed = await api().post(`/api/orders/${order.id}/proposals`).set(shopper.auth).send({ lines }).expect(201);
  expect(proposed.body.status).toBe('APPROVED');
  expect(proposed.body.currentProposal.approval.method).toBe('AUTO');

  const purchased = await api().post(`/api/orders/${order.id}/purchase`).set(shopper.auth).send(buyAll(proposed.body)).expect(201);
  expect(purchased.body.goods_total_minor).toBe(4500);
  expect(purchased.body.final_total_minor).toBe(4500 + FEE);

  const pay = await api().post(`/api/orders/${order.id}/payments`).set(customer.auth).set('Idempotency-Key', key())
    .send({ outcome: 'success' }).expect(201);
  expect(pay.body.payment.amount_minor).toBe(4500 + FEE);

  await api().post(`/api/orders/${order.id}/out-for-delivery`).set(shopper.auth).expect(200);
  await api().post(`/api/orders/${order.id}/delivered`).set(shopper.auth).expect(200);
  const done = await api().post(`/api/orders/${order.id}/confirm-receipt`).set(customer.auth).expect(200);

  expect(done.body.status).toBe('COMPLETED');
  expect(done.body.final_total_minor).toBe(6000);
  expect(done.body.purchase.lines).toHaveLength(3);
  expect(done.body.events.map((e: { type: string }) => e.type)).toEqual([
    'ORDER_SUBMITTED', 'SHOPPER_ASSIGNED', 'PROPOSAL_AUTO_APPROVED', 'PURCHASE_RECORDED',
    'PAYMENT_SUCCEEDED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RECEIPT_CONFIRMED',
  ]);
  for (const e of done.body.events) expect(e.created_at).toBeTruthy();

  // The shopper sees the same breakdown and history.
  const shopperView = await api().get(`/api/orders/${order.id}`).set(shopper.auth).expect(200);
  expect(shopperView.body.final_total_minor).toBe(6000);
  expect(shopperView.body.events).toHaveLength(8);
});

test('AS-2: two shoppers accept simultaneously → exactly one is assigned', async () => {
  const customer = await register('customer');
  const shoppers = await Promise.all([register('shopper'), register('shopper')]);
  // Repeat to give the race a real chance to occur.
  for (let round = 0; round < 5; round++) {
    const order = await placeOrder(customer, [{ name: 'Bread', quantity: 1 }]);
    const results = await Promise.all(
      shoppers.map((s) => api().post(`/api/orders/${order.id}/accept`).set(s.auth)),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('ALREADY_ASSIGNED');

    const row = await db('orders').where({ id: order.id }).first();
    const winner = results.findIndex((r) => r.status === 200);
    expect(row.shopper_id).toBe(shoppers[winner].id);
    const assignEvents = await db('order_events').where({ order_id: order.id, type: 'SHOPPER_ASSIGNED' });
    expect(assignEvents).toHaveLength(1);
  }
});

test('AS-3: substitute above budget → purchase blocked until customer approves revised total', async () => {
  const customer = await register('customer');
  const shopper = await register('shopper');
  const order = await placeOrder(customer, [{ name: 'Olive oil 1L', quantity: 1 }], 5000);
  await api().post(`/api/orders/${order.id}/accept`).set(shopper.auth).expect(200);

  const proposed = await api().post(`/api/orders/${order.id}/proposals`).set(shopper.auth).send({
    lines: [{ orderItemId: order.items[0].id, kind: 'SUBSTITUTE', name: 'Premium olive oil 1L', quantity: 1, unitPriceMinor: 7000 }],
  }).expect(201);
  expect(proposed.body.status).toBe('AWAITING_APPROVAL');
  expect(proposed.body.currentProposal.total_minor).toBe(7000 + FEE);

  const blocked = await api().post(`/api/orders/${order.id}/purchase`).set(shopper.auth).send(buyAll(proposed.body)).expect(409);
  expect(blocked.body.error.code).toBe('INVALID_STATE_TRANSITION');
  expect(blocked.body.error.message).toMatch(/blocked until the customer approves/);

  const p = proposed.body.currentProposal;
  const approved = await api().post(`/api/orders/${order.id}/proposals/${p.id}/approve`).set(customer.auth)
    .send({ version: p.version }).expect(200);
  expect(approved.body.status).toBe('APPROVED');
  expect(approved.body.currentProposal.approval.approved_amount_minor).toBe(7000 + FEE);

  await api().post(`/api/orders/${order.id}/purchase`).set(shopper.auth).send(buyAll(approved.body)).expect(201);
});

test('AS-4: proposal changed after approval → old approval cannot authorise the changed purchase', async () => {
  const customer = await register('customer');
  const shopper = await register('shopper');
  const order = await placeOrder(customer, [{ name: 'Chicken', quantity: 1 }], 5000);
  await api().post(`/api/orders/${order.id}/accept`).set(shopper.auth).expect(200);

  const v1 = await api().post(`/api/orders/${order.id}/proposals`).set(shopper.auth).send({
    lines: [{ orderItemId: order.items[0].id, kind: 'SUBSTITUTE', name: 'Turkey', quantity: 1, unitPriceMinor: 4000 }],
  }).expect(201);
  const p1 = v1.body.currentProposal;
  await api().post(`/api/orders/${order.id}/proposals/${p1.id}/approve`).set(customer.auth).send({ version: 1 }).expect(200);

  // Shopper changes the proposal after approval (more expensive substitute).
  const v2 = await api().post(`/api/orders/${order.id}/proposals`).set(shopper.auth).send({
    lines: [{ orderItemId: order.items[0].id, kind: 'SUBSTITUTE', name: 'Duck', quantity: 1, unitPriceMinor: 4800 }],
  }).expect(201);
  expect(v2.body.status).toBe('AWAITING_APPROVAL');
  expect(v2.body.currentProposal.version).toBe(2);
  expect(v2.body.currentProposal.approval).toBeNull();

  // Purchasing against the new proposal is blocked: v1's approval doesn't carry over.
  await api().post(`/api/orders/${order.id}/purchase`).set(shopper.auth).send(buyAll(v2.body)).expect(409);
  // Purchasing using v1's line ids is also rejected.
  const stale = await api().post(`/api/orders/${order.id}/purchase`).set(shopper.auth).send(buyAll(v1.body));
  expect(stale.status).toBe(409);

  // Re-using the old approval (approving v1 again) is rejected as stale.
  const reuse = await api().post(`/api/orders/${order.id}/proposals/${p1.id}/approve`).set(customer.auth).send({ version: 1 }).expect(409);
  expect(reuse.body.error.code).toBe('STALE_PROPOSAL');

  const v1Row = await db('proposals').where({ id: p1.id }).first();
  expect(v1Row.status).toBe('SUPERSEDED');
});

test('AS-5: customer cannot read another customer’s order; unassigned shopper cannot change status', async () => {
  const owner = await register('customer');
  const other = await register('customer');
  const assigned = await register('shopper');
  const outsider = await register('shopper');
  const order = await placeOrder(owner);

  const read = await api().get(`/api/orders/${order.id}`).set(other.auth).expect(403);
  expect(read.body.error.code).toBe('FORBIDDEN');
  const list = await api().get('/api/orders').set(other.auth).expect(200);
  expect(list.body.orders.find((o: { id: number }) => o.id === order.id)).toBeUndefined();
  await api().post(`/api/orders/${order.id}/cancel`).set(other.auth).expect(403);

  await api().post(`/api/orders/${order.id}/accept`).set(assigned.auth).expect(200);

  // Every shopper action is refused for the unassigned shopper.
  await api().post(`/api/orders/${order.id}/proposals`).set(outsider.auth).send({ lines: asRequested(order) }).expect(403);
  await api().post(`/api/orders/${order.id}/out-for-delivery`).set(outsider.auth).expect(403);
  await api().post(`/api/orders/${order.id}/delivered`).set(outsider.auth).expect(403);
  // And once assigned, they can no longer read it either.
  await api().get(`/api/orders/${order.id}`).set(outsider.auth).expect(403);

  const row = await db('orders').where({ id: order.id }).first();
  expect(row.status).toBe('ASSIGNED');
});

test('AS-6: payment fails then retried → dispatch blocked until success; one successful payment', async () => {
  const customer = await register('customer');
  const shopper = await register('shopper');
  const order = await placeOrder(customer);
  await api().post(`/api/orders/${order.id}/accept`).set(shopper.auth).expect(200);
  const proposed = await api().post(`/api/orders/${order.id}/proposals`).set(shopper.auth).send({ lines: asRequested(order) }).expect(201);
  await api().post(`/api/orders/${order.id}/purchase`).set(shopper.auth).send(buyAll(proposed.body)).expect(201);

  const failed = await api().post(`/api/orders/${order.id}/payments`).set(customer.auth).set('Idempotency-Key', key())
    .send({ outcome: 'failure' }).expect(201);
  expect(failed.body.payment.status).toBe('FAILED');

  const blocked = await api().post(`/api/orders/${order.id}/out-for-delivery`).set(shopper.auth).expect(409);
  expect(blocked.body.error.message).toMatch(/blocked until payment succeeds/);

  // Retry with a new key succeeds; the client then retries the *same* request (network blip) and
  // also double-submits with fresh keys concurrently.
  const retryKey = key();
  const ok = await api().post(`/api/orders/${order.id}/payments`).set(customer.auth).set('Idempotency-Key', retryKey)
    .send({ outcome: 'success' }).expect(201);
  expect(ok.body.payment.status).toBe('SUCCEEDED');

  const replay = await api().post(`/api/orders/${order.id}/payments`).set(customer.auth).set('Idempotency-Key', retryKey)
    .send({ outcome: 'success' }).expect(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.payment.id).toBe(ok.body.payment.id);

  const concurrent = await Promise.all([1, 2, 3].map(() =>
    api().post(`/api/orders/${order.id}/payments`).set(customer.auth).set('Idempotency-Key', key()).send({ outcome: 'success' })));
  for (const r of concurrent) {
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ALREADY_PAID');
  }

  const successes = await db('payments').where({ order_id: order.id, status: 'SUCCEEDED' });
  expect(successes).toHaveLength(1);

  await api().post(`/api/orders/${order.id}/out-for-delivery`).set(shopper.auth).expect(200);
});

test('AS-6b: concurrent first payment attempts → still only one success', async () => {
  const customer = await register('customer');
  const shopper = await register('shopper');
  const order = await placeOrder(customer, [{ name: 'Sugar', quantity: 1 }]);
  await api().post(`/api/orders/${order.id}/accept`).set(shopper.auth).expect(200);
  const proposed = await api().post(`/api/orders/${order.id}/proposals`).set(shopper.auth).send({ lines: asRequested(order) }).expect(201);
  await api().post(`/api/orders/${order.id}/purchase`).set(shopper.auth).send(buyAll(proposed.body)).expect(201);

  const results = await Promise.all([1, 2, 3, 4].map(() =>
    api().post(`/api/orders/${order.id}/payments`).set(customer.auth).set('Idempotency-Key', key()).send({ outcome: 'success' })));
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  expect(await db('payments').where({ order_id: order.id, status: 'SUCCEEDED' })).toHaveLength(1);
});
