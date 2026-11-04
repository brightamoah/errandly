import { admin, api, asRequested, buyAll, db, FEE, key, placeOrder, register, resetDb, TestUser } from './helpers';

beforeAll(resetDb);
afterAll(() => db.destroy());

async function toApproved(customer: TestUser, shopper: TestUser, unitPrice = 1000, budget = 10000) {
  const order = await placeOrder(customer, undefined, budget);
  await api().post(`/api/orders/${order.id}/accept`).set(shopper.auth).expect(200);
  const res = await api().post(`/api/orders/${order.id}/proposals`).set(shopper.auth)
    .send({ lines: asRequested(order, unitPrice) }).expect(201);
  return res.body;
}

async function toPurchased(customer: TestUser, shopper: TestUser) {
  const approved = await toApproved(customer, shopper);
  const res = await api().post(`/api/orders/${approved.id}/purchase`).set(shopper.auth).send(buyAll(approved)).expect(201);
  return res.body;
}

describe('MR-02 cart and submission', () => {
  test('cart is private to each customer and can be edited', async () => {
    const a = await register('customer');
    const b = await register('customer');
    const item = await api().post('/api/cart/items').set(a.auth).send({ name: 'Yam', quantity: 2 }).expect(201);
    await api().patch(`/api/cart/items/${item.body.id}`).set(a.auth).send({ quantity: 4 }).expect(200);
    await api().patch(`/api/cart/items/${item.body.id}`).set(b.auth).send({ quantity: 1 }).expect(404);
    await api().delete(`/api/cart/items/${item.body.id}`).set(b.auth).expect(404);
    const cart = await api().get('/api/cart').set(a.auth).expect(200);
    expect(cart.body.items).toEqual([expect.objectContaining({ name: 'Yam', quantity: 4 })]);
    expect((await api().get('/api/cart').set(b.auth)).body.items).toEqual([]);
  });

  test('empty cart cannot be submitted', async () => {
    const c = await register('customer');
    const res = await api().post('/api/orders').set(c.auth).set('Idempotency-Key', key())
      .send({ budgetMinor: 5000, deliveryAddress: '1 Ring Road, Accra' }).expect(422);
    expect(res.body.error.code).toBe('CART_EMPTY');
  });

  test('repeated submission with same key returns the same order, no duplicate', async () => {
    const c = await register('customer');
    await api().post('/api/cart/items').set(c.auth).send({ name: 'Beans', quantity: 1 }).expect(201);
    const k = key();
    const send = () => api().post('/api/orders').set(c.auth).set('Idempotency-Key', k)
      .send({ budgetMinor: 5000, deliveryAddress: '1 Ring Road, Accra' });
    const [r1, r2, r3] = await Promise.all([send(), send(), send()]);
    const ids = new Set([r1.body.id, r2.body.id, r3.body.id]);
    expect(ids.size).toBe(1);
    expect([r1.status, r2.status, r3.status].sort()).toEqual([200, 200, 201]);
    expect(await db('orders').where({ customer_id: c.id })).toHaveLength(1);
  });

  test('submission requires an idempotency key and valid budget', async () => {
    const c = await register('customer');
    await api().post('/api/cart/items').set(c.auth).send({ name: 'Beans', quantity: 1 });
    const noKey = await api().post('/api/orders').set(c.auth).send({ budgetMinor: 5000, deliveryAddress: '1 Ring Road' }).expect(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const bad = await api().post('/api/orders').set(c.auth).set('Idempotency-Key', key())
      .send({ budgetMinor: 12.5, deliveryAddress: 'x' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['budgetMinor', 'deliveryAddress']));
  });

  test('fee is stored at submission', async () => {
    const c = await register('customer');
    const order = await placeOrder(c);
    expect(order.fee_minor).toBe(FEE);
    expect(order.items.map((i: { name: string }) => i.name)).toEqual(['Rice', 'Eggs', 'Milk']);
    expect((await api().get('/api/cart').set(c.auth)).body.items).toEqual([]);
  });
});

describe('MR-04 proposals', () => {
  test('within budget and no substitutes → auto-approved; over budget → needs approval', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const within = await toApproved(c, s, 1000, 10000); // 6 units × 1000 = 6000 ≤ 10000
    expect(within.status).toBe('APPROVED');

    const over = await toApproved(c, s, 2000, 10000); // 12000 > 10000
    expect(over.status).toBe('AWAITING_APPROVAL');
    expect(over.events.at(-1).note).toMatch(/exceeds budget/);
  });

  test('proposal must cover every item exactly once', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const order = await placeOrder(c);
    await api().post(`/api/orders/${order.id}/accept`).set(s.auth).expect(200);
    const partial = await api().post(`/api/orders/${order.id}/proposals`).set(s.auth)
      .send({ lines: asRequested(order).slice(0, 2) }).expect(422);
    expect(partial.body.error.code).toBe('INCOMPLETE_PROPOSAL');
    const lines = asRequested(order);
    lines[1] = { ...lines[0] };
    const dup = await api().post(`/api/orders/${order.id}/proposals`).set(s.auth).send({ lines }).expect(422);
    expect(dup.body.error.code).toBe('DUPLICATE_ORDER_ITEM');
  });

  test('unavailable items cost nothing; rejected proposal can be revised', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const order = await placeOrder(c);
    await api().post(`/api/orders/${order.id}/accept`).set(s.auth).expect(200);
    const lines = asRequested(order, 1000);
    lines[0] = { orderItemId: order.items[0].id, kind: 'SUBSTITUTE', name: 'Brown rice', quantity: 1, unitPriceMinor: 1500 } as never;
    lines[2] = { ...lines[2], kind: 'UNAVAILABLE' };
    const v1 = await api().post(`/api/orders/${order.id}/proposals`).set(s.auth).send({ lines }).expect(201);
    expect(v1.body.currentProposal.goods_total_minor).toBe(1500 + 2000);

    await api().post(`/api/orders/${order.id}/proposals/${v1.body.currentProposal.id}/reject`).set(c.auth)
      .send({ reason: 'No brown rice please' }).expect(200);

    const revised = asRequested(order, 1000);
    revised[2] = { ...revised[2], kind: 'UNAVAILABLE' };
    const v2 = await api().post(`/api/orders/${order.id}/proposals`).set(s.auth).send({ lines: revised }).expect(201);
    expect(v2.body.status).toBe('APPROVED');
    expect(v2.body.currentProposal.version).toBe(2);
    expect(v2.body.proposalHistory.map((p: { status: string }) => p.status)).toEqual(['SUPERSEDED', 'APPROVED']);
  });

  test('approving with the wrong version is rejected as stale', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const over = await toApproved(c, s, 2000);
    const p = over.currentProposal;
    const res = await api().post(`/api/orders/${over.id}/proposals/${p.id}/approve`).set(c.auth).send({ version: 99 }).expect(409);
    expect(res.body.error.code).toBe('STALE_PROPOSAL');
  });
});

describe('MR-05 purchase', () => {
  test('server calculates totals; client cannot send a total', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const approved = await toApproved(c, s);
    const withTotal = await api().post(`/api/orders/${approved.id}/purchase`).set(s.auth)
      .send({ ...buyAll(approved), finalTotalMinor: 1 }).expect(400);
    expect(withTotal.body.error.code).toBe('VALIDATION_ERROR');

    // Buy only part of one line at a lower price than proposed.
    const body = buyAll(approved);
    body.lines[2] = { ...body.lines[2], quantity: 1, unitPriceMinor: 800 };
    const res = await api().post(`/api/orders/${approved.id}/purchase`).set(s.auth).send(body).expect(201);
    expect(res.body.goods_total_minor).toBe(1000 + 2000 + 800);
    expect(res.body.final_total_minor).toBe(3800 + FEE);
    expect(res.body.purchase.receipt_number).toBe('R-1001');
  });

  test('final total cannot exceed the approved amount', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const approved = await toApproved(c, s);
    const body = buyAll(approved);
    body.lines[0].unitPriceMinor = 5000; // actual shelf price higher than proposed
    const res = await api().post(`/api/orders/${approved.id}/purchase`).set(s.auth).send(body).expect(422);
    expect(res.body.error.code).toBe('EXCEEDS_APPROVED_AMOUNT');
    expect(res.body.error.details).toEqual({ finalTotalMinor: 5000 + 2000 + 3000 + FEE, approvedAmountMinor: 6000 + FEE });
  });

  test('cannot buy more than the approved quantity, or record a purchase twice', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const approved = await toApproved(c, s);
    const body = buyAll(approved);
    const tooMany = { ...body, lines: [{ ...body.lines[0], quantity: 5, unitPriceMinor: 1 }] };
    const r = await api().post(`/api/orders/${approved.id}/purchase`).set(s.auth).send(tooMany).expect(422);
    expect(r.body.error.code).toBe('QUANTITY_EXCEEDS_PROPOSAL');

    const [a, b] = await Promise.all([
      api().post(`/api/orders/${approved.id}/purchase`).set(s.auth).send(body),
      api().post(`/api/orders/${approved.id}/purchase`).set(s.auth).send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await db('purchases').where({ order_id: approved.id })).toHaveLength(1);
  });
});

describe('MR-06 delivery', () => {
  test('cannot skip steps: delivered before dispatch, confirm before delivered', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const purchased = await toPurchased(c, s);
    await api().post(`/api/orders/${purchased.id}/payments`).set(c.auth).set('Idempotency-Key', key()).send({ outcome: 'success' }).expect(201);
    const early = await api().post(`/api/orders/${purchased.id}/delivered`).set(s.auth).expect(409);
    expect(early.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: { currentStatus: 'PAID', attemptedStatus: 'DELIVERED' } });
    await api().post(`/api/orders/${purchased.id}/confirm-receipt`).set(c.auth).expect(409);
    await api().post(`/api/orders/${purchased.id}/out-for-delivery`).set(s.auth).expect(200);
    await api().post(`/api/orders/${purchased.id}/delivered`).set(s.auth).expect(200);
    // Shopper cannot complete on the customer's behalf.
    await api().post(`/api/orders/${purchased.id}/confirm-receipt`).set(s.auth).expect(403);
    await api().post(`/api/orders/${purchased.id}/confirm-receipt`).set(c.auth).expect(200);
    await api().post(`/api/orders/${purchased.id}/confirm-receipt`).set(c.auth).expect(409);
  });

  test('every status change records who did it', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const purchased = await toPurchased(c, s);
    const events = await db('order_events').where({ order_id: purchased.id }).orderBy('id');
    expect(events.map((e) => [e.type, e.actor_id, e.actor_role])).toEqual([
      ['ORDER_SUBMITTED', c.id, 'customer'],
      ['SHOPPER_ASSIGNED', s.id, 'shopper'],
      ['PROPOSAL_AUTO_APPROVED', null, 'system'],
      ['PURCHASE_RECORDED', s.id, 'shopper'],
    ]);
  });
});

describe('MR-07 cancellation and issues', () => {
  test('customer can cancel before purchase, with no charge', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const approved = await toApproved(c, s);
    const res = await api().post(`/api/orders/${approved.id}/cancel`).set(c.auth).send({}).expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.payments).toEqual([]);
    expect(res.body.final_total_minor).toBeNull();
    // A cancelled order can't be resumed.
    await api().post(`/api/orders/${approved.id}/purchase`).set(s.auth).send(buyAll(approved)).expect(409);
  });

  test('rejected proposal can be cancelled', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const over = await toApproved(c, s, 2000);
    await api().post(`/api/orders/${over.id}/proposals/${over.currentProposal.id}/reject`).set(c.auth).send({}).expect(200);
    const res = await api().post(`/api/orders/${over.id}/cancel`).set(c.auth).send({}).expect(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  test('after purchase: cancel refused, issue reported, admin resolves', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const adm = await admin();
    const purchased = await toPurchased(c, s);

    const cancel = await api().post(`/api/orders/${purchased.id}/cancel`).set(c.auth).send({}).expect(409);
    expect(cancel.body.error.message).toMatch(/report an issue/);

    const issue = await api().post(`/api/orders/${purchased.id}/issues`).set(c.auth)
      .send({ description: 'Two eggs were cracked' }).expect(201);
    expect((await db('orders').where({ id: purchased.id }).first()).has_open_issue).toBe(true);

    await api().post(`/api/admin/issues/${issue.body.id}/resolve`).set(c.auth).send({ resolutionNotes: 'nope' }).expect(403);
    const list = await api().get('/api/admin/issues?status=OPEN').set(adm.auth).expect(200);
    expect(list.body.issues.map((i: { id: number }) => i.id)).toContain(issue.body.id);

    const resolved = await api().post(`/api/admin/issues/${issue.body.id}/resolve`).set(adm.auth)
      .send({ resolutionNotes: 'Shopper to replace the eggs on next order' }).expect(200);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolved_by: adm.id });
    expect((await db('orders').where({ id: purchased.id }).first()).has_open_issue).toBe(false);
    await api().post(`/api/admin/issues/${issue.body.id}/resolve`).set(adm.auth).send({ resolutionNotes: 'again please' }).expect(409);
  });

  test('issues cannot be reported before purchase', async () => {
    const c = await register('customer');
    const order = await placeOrder(c);
    const res = await api().post(`/api/orders/${order.id}/issues`).set(c.auth).send({ description: 'Changed my mind' }).expect(409);
    expect(res.body.error.code).toBe('ISSUE_NOT_ALLOWED');
  });
});

describe('MR-08 payments', () => {
  test('cannot pay before purchase', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const approved = await toApproved(c, s);
    await api().post(`/api/orders/${approved.id}/payments`).set(c.auth).set('Idempotency-Key', key()).send({ outcome: 'success' }).expect(409);
  });

  test('payment charges the server-calculated final total', async () => {
    const c = await register('customer');
    const s = await register('shopper');
    const purchased = await toPurchased(c, s);
    const res = await api().post(`/api/orders/${purchased.id}/payments`).set(c.auth).set('Idempotency-Key', key())
      .send({ outcome: 'success', amountMinor: 1 }).expect(201);
    expect(res.body.payment.amount_minor).toBe(purchased.final_total_minor);
  });
});
