import bcrypt from 'bcryptjs';
import { Request, Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, signToken } from '../auth';
import { config } from '../config';
import { db } from '../db';
import { AppError, ah, notFound } from '../errors';
import * as orders from '../services/orders';

export const router = Router();

const id = z.coerce.number().int().positive();
const money = z.number().int('Amounts are integers in minor units (e.g. pesewas)').nonnegative();

function idempotencyKey(req: Request): string {
  const key = req.header('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 100) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–100 characters), e.g. a UUID');
  }
  return key;
}

const orderId = (req: Request) => id.parse(req.params.id);

/* ---------------------------- MR-01: accounts ---------------------------- */

router.post('/auth/register', ah(async (req, res) => {
  const body = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8, 'Password must be at least 8 characters').max(200),
    name: z.string().trim().min(1).max(120),
    role: z.enum(['customer', 'shopper']), // admins are provisioned, never self-registered
  }).parse(req.body);

  const exists = await db('users').where({ email: body.email }).first();
  if (exists) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');

  const [user] = await db('users')
    .insert({ email: body.email, name: body.name, role: body.role, password_hash: await bcrypt.hash(body.password, 10) })
    .returning(['id', 'email', 'name', 'role']);
  res.status(201).json({ token: signToken(user), user });
}));

router.post('/auth/login', ah(async (req, res) => {
  const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
  const user = await db('users').where({ email: body.email }).first();
  if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role };
  res.json({ token: signToken(publicUser), user: publicUser });
}));

router.get('/config', (_req, res) => res.json({ currency: config.currency, serviceFeeMinor: config.serviceFee }));

router.use(authenticate);

router.get('/auth/me', (req, res) => res.json({ user: req.user }));

/* ------------------------------ MR-02: cart ------------------------------ */

const cartItem = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(999),
  notes: z.string().trim().max(500).optional(),
});

router.get('/cart', requireRole('customer'), ah(async (req, res) => {
  res.json({ items: await db('cart_items').where({ customer_id: req.user!.id }).orderBy('id') });
}));

router.post('/cart/items', requireRole('customer'), ah(async (req, res) => {
  const body = cartItem.parse(req.body);
  const [item] = await db('cart_items').insert({ ...body, customer_id: req.user!.id }).returning('*');
  res.status(201).json(item);
}));

router.patch('/cart/items/:itemId', requireRole('customer'), ah(async (req, res) => {
  const body = cartItem.partial().parse(req.body);
  const [item] = await db('cart_items')
    .where({ id: id.parse(req.params.itemId), customer_id: req.user!.id })
    .update(body)
    .returning('*');
  if (!item) throw notFound('Cart item');
  res.json(item);
}));

router.delete('/cart/items/:itemId', requireRole('customer'), ah(async (req, res) => {
  const n = await db('cart_items').where({ id: id.parse(req.params.itemId), customer_id: req.user!.id }).delete();
  if (!n) throw notFound('Cart item');
  res.status(204).end();
}));

/* ------------------------- MR-02: order submission ------------------------ */

router.post('/orders', requireRole('customer'), ah(async (req, res) => {
  const body = z.object({
    budgetMinor: money.positive('Budget must be greater than zero'),
    deliveryAddress: z.string().trim().min(5).max(500),
    notes: z.string().trim().max(1000).optional(),
  }).parse(req.body);
  const result = await orders.submitOrder(req.user!, body, idempotencyKey(req));
  res.status(result.replayed ? 200 : 201).json(await orders.getOrderDetail(req.user!, result.orderId));
}));

router.get('/orders', ah(async (req, res) => {
  const status = z.string().max(32).optional().parse(req.query.status);
  res.json({ orders: await orders.listOrders(req.user!, status) });
}));

router.get('/orders/available', requireRole('shopper'), ah(async (_req, res) => {
  res.json({ orders: await orders.listAvailableOrders() });
}));

router.get('/orders/:id', ah(async (req, res) => {
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

/* ------------------------ MR-03: shopper assignment ----------------------- */

router.post('/orders/:id/accept', requireRole('shopper'), ah(async (req, res) => {
  await orders.acceptOrder(req.user!, orderId(req));
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

/* ---------------------- MR-04: proposals and approval --------------------- */

router.post('/orders/:id/proposals', requireRole('shopper'), ah(async (req, res) => {
  const body = z.object({
    lines: z.array(z.object({
      orderItemId: id,
      kind: z.enum(['AS_REQUESTED', 'SUBSTITUTE', 'UNAVAILABLE']),
      name: z.string().trim().min(1).max(200).optional(),
      quantity: z.number().int().min(0).max(999),
      unitPriceMinor: money,
      note: z.string().trim().max(500).optional(),
    })).min(1),
  }).parse(req.body);
  await orders.createProposal(req.user!, orderId(req), body.lines);
  res.status(201).json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

router.post('/orders/:id/proposals/:proposalId/approve', requireRole('customer'), ah(async (req, res) => {
  const body = z.object({ version: z.number().int().positive() }).parse(req.body);
  await orders.approveProposal(req.user!, orderId(req), id.parse(req.params.proposalId), body.version);
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

router.post('/orders/:id/proposals/:proposalId/reject', requireRole('customer'), ah(async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  await orders.rejectProposal(req.user!, orderId(req), id.parse(req.params.proposalId), body.reason);
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

/* ---------------------- MR-05: purchase and receipt ----------------------- */

router.post('/orders/:id/purchase', requireRole('shopper'), ah(async (req, res) => {
  const body = z.object({
    storeName: z.string().trim().min(1).max(200),
    receiptNumber: z.string().trim().min(1).max(100),
    receiptNote: z.string().trim().max(1000).optional(),
    lines: z.array(z.object({
      proposalLineId: id,
      quantity: z.number().int().min(1).max(999),
      unitPriceMinor: money,
    })).min(1),
  }).strict().parse(req.body); // .strict(): a client-supplied "total" is rejected, not ignored
  await orders.recordPurchase(req.user!, orderId(req), body);
  res.status(201).json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

/* ------------------------ MR-08: simulated payment ------------------------ */

router.post('/orders/:id/payments', requireRole('customer'), ah(async (req, res) => {
  const body = z.object({ outcome: z.enum(['success', 'failure']) }).parse(req.body);
  const result = await orders.payOrder(req.user!, orderId(req), body.outcome, idempotencyKey(req));
  res.status(result.replayed ? 200 : 201).json({ payment: result.payment, replayed: result.replayed });
}));

/* --------------------------- MR-06: delivery ----------------------------- */

router.post('/orders/:id/out-for-delivery', requireRole('shopper'), ah(async (req, res) => {
  await orders.markOutForDelivery(req.user!, orderId(req));
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

router.post('/orders/:id/delivered', requireRole('shopper'), ah(async (req, res) => {
  await orders.markDelivered(req.user!, orderId(req));
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

router.post('/orders/:id/confirm-receipt', requireRole('customer'), ah(async (req, res) => {
  await orders.confirmReceipt(req.user!, orderId(req));
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

/* --------------------- MR-07: cancellation and issues --------------------- */

router.post('/orders/:id/cancel', requireRole('customer'), ah(async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  await orders.cancelOrder(req.user!, orderId(req), body.reason);
  res.json(await orders.getOrderDetail(req.user!, orderId(req)));
}));

router.post('/orders/:id/issues', requireRole('customer'), ah(async (req, res) => {
  const body = z.object({ description: z.string().trim().min(5).max(2000) }).parse(req.body);
  const issue = await orders.reportIssue(req.user!, orderId(req), body.description);
  res.status(201).json(issue);
}));

router.get('/admin/issues', requireRole('admin'), ah(async (req, res) => {
  const status = z.enum(['OPEN', 'RESOLVED']).optional().parse(req.query.status);
  const q = db('issues as i')
    .join('users as u', 'u.id', 'i.reported_by')
    .join('orders as o', 'o.id', 'i.order_id')
    .select('i.*', 'u.name as reporter_name', 'o.status as order_status', 'o.final_total_minor', 'o.currency')
    .orderBy('i.id', 'desc');
  if (status) q.where('i.status', status);
  res.json({ issues: await q });
}));

router.post('/admin/issues/:issueId/resolve', requireRole('admin'), ah(async (req, res) => {
  const body = z.object({ resolutionNotes: z.string().trim().min(5).max(2000) }).parse(req.body);
  res.json(await orders.resolveIssue(req.user!, id.parse(req.params.issueId), body.resolutionNotes));
}));
