import { api, db, placeOrder, register, resetDb } from './helpers';

beforeAll(resetDb);
afterAll(() => db.destroy());

describe('MR-01 accounts and authentication', () => {
  test('register, login and me', async () => {
    const reg = await api().post('/api/auth/register')
      .send({ email: 'Kofi@Example.com', password: 'longenough', name: 'Kofi', role: 'customer' }).expect(201);
    expect(reg.body.user).toMatchObject({ email: 'kofi@example.com', role: 'customer' });
    expect(reg.body.user.password_hash).toBeUndefined();

    const login = await api().post('/api/auth/login').send({ email: 'kofi@example.com', password: 'longenough' }).expect(200);
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`).expect(200);
    expect(me.body.user.email).toBe('kofi@example.com');
  });

  test('duplicate email, weak password, wrong password', async () => {
    await api().post('/api/auth/register').send({ email: 'a@b.co', password: 'longenough', name: 'A', role: 'shopper' }).expect(201);
    const dup = await api().post('/api/auth/register').send({ email: 'a@b.co', password: 'longenough', name: 'A', role: 'shopper' }).expect(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    await api().post('/api/auth/register').send({ email: 'c@b.co', password: 'short', name: 'C', role: 'shopper' }).expect(400);
    const bad = await api().post('/api/auth/login').send({ email: 'a@b.co', password: 'wrongpassword' }).expect(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('nobody can self-register as admin', async () => {
    await api().post('/api/auth/register').send({ email: 'x@b.co', password: 'longenough', name: 'X', role: 'admin' }).expect(400);
  });

  test('missing, malformed and forged tokens are rejected', async () => {
    await api().get('/api/orders').expect(401);
    await api().get('/api/orders').set('Authorization', 'Token abc').expect(401);
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIn0.invalidsig';
    const res = await api().get('/api/admin/issues').set('Authorization', `Bearer ${forged}`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('role-based permissions', () => {
  test('roles are enforced on every endpoint family', async () => {
    const customer = await register('customer');
    const shopper = await register('shopper');
    const order = await placeOrder(customer);

    await api().get('/api/cart').set(shopper.auth).expect(403);
    await api().get('/api/orders/available').set(customer.auth).expect(403);
    await api().post(`/api/orders/${order.id}/accept`).set(customer.auth).expect(403);
    await api().post(`/api/orders/${order.id}/cancel`).set(shopper.auth).expect(403);
    await api().get('/api/admin/issues').set(customer.auth).expect(403);
    await api().get('/api/admin/issues').set(shopper.auth).expect(403);
  });

  test('shoppers see unassigned requests but not the customer’s history', async () => {
    const customer = await register('customer');
    const shopper = await register('shopper');
    const order = await placeOrder(customer);
    const available = await api().get('/api/orders/available').set(shopper.auth).expect(200);
    expect(available.body.orders.map((o: { id: number }) => o.id)).toContain(order.id);
    const view = await api().get(`/api/orders/${order.id}`).set(shopper.auth).expect(200);
    expect(view.body.items).toHaveLength(3);
    expect(view.body.events).toEqual([]);
  });

  test('unknown order → 404, non-numeric id → 400', async () => {
    const customer = await register('customer');
    await api().get('/api/orders/999999').set(customer.auth).expect(404);
    await api().get('/api/orders/abc').set(customer.auth).expect(400);
  });

  test('malformed JSON gets a clear error', async () => {
    const customer = await register('customer');
    const res = await api().post('/api/cart/items').set(customer.auth).set('Content-Type', 'application/json').send('{"name":').expect(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
});
