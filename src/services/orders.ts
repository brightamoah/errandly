import crypto from 'crypto';
import { Knex } from 'knex';
import { AuthUser } from '../auth';
import { config } from '../config';
import { db } from '../db';
import { AppError, forbidden, notFound } from '../errors';
import {
  CANCELLABLE,
  ISSUE_REPORTABLE,
  OrderStatus,
  PROPOSABLE,
  TRANSITIONS,
} from '../domain/orderStatus';

type Trx = Knex.Transaction;

export interface OrderRow {
  id: number;
  customer_id: number;
  shopper_id: number | null;
  status: OrderStatus;
  budget_minor: number;
  fee_minor: number;
  currency: string;
  delivery_address: string;
  notes: string | null;
  current_proposal_id: number | null;
  goods_total_minor: number | null;
  final_total_minor: number | null;
  has_open_issue: boolean;
  created_at: Date;
  updated_at: Date;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

async function lockOrder(trx: Trx, orderId: number): Promise<OrderRow> {
  const order = await trx<OrderRow>('orders').where({ id: orderId }).forUpdate().first();
  if (!order) throw notFound('Order');
  return order;
}

function assertOwner(order: OrderRow, user: AuthUser) {
  if (user.role !== 'customer' || order.customer_id !== user.id) {
    throw forbidden('Only the customer who placed this order can do this');
  }
}

function assertAssignedShopper(order: OrderRow, user: AuthUser) {
  if (user.role !== 'shopper' || order.shopper_id !== user.id) {
    throw forbidden('Only the shopper assigned to this order can do this');
  }
}

export function canView(order: OrderRow, user: AuthUser): boolean {
  if (user.role === 'admin') return true;
  if (user.role === 'customer') return order.customer_id === user.id;
  // Shoppers see their own assignments, and unassigned requests they could accept.
  return order.shopper_id === user.id || (order.status === 'SUBMITTED' && order.shopper_id === null);
}

function invalidTransition(order: OrderRow, to: OrderStatus | string, why?: string): AppError {
  return new AppError(
    409,
    'INVALID_STATE_TRANSITION',
    why ?? `Cannot move order from ${order.status} to ${to}`,
    { currentStatus: order.status, attemptedStatus: to },
  );
}

/** The single place where order status changes happen. Always records history. */
async function transition(
  trx: Trx,
  order: OrderRow,
  to: OrderStatus,
  actor: AuthUser | null,
  type: string,
  note?: string,
  extra: Partial<OrderRow> = {},
): Promise<void> {
  if (!TRANSITIONS[order.status].includes(to)) throw invalidTransition(order, to);
  await trx('orders')
    .where({ id: order.id })
    .update({ ...extra, status: to, updated_at: trx.fn.now() });
  await recordEvent(trx, order.id, type, actor, order.status, to, note);
  order.status = to;
}

async function recordEvent(
  trx: Trx | Knex,
  orderId: number,
  type: string,
  actor: AuthUser | null,
  from: string | null,
  to: string | null,
  note?: string,
) {
  await trx('order_events').insert({
    order_id: orderId,
    type,
    from_status: from,
    to_status: to,
    actor_id: actor?.id ?? null,
    actor_role: actor?.role ?? 'system',
    note: note ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* MR-02: submission                                                   */
/* ------------------------------------------------------------------ */

export async function submitOrder(
  user: AuthUser,
  input: { budgetMinor: number; deliveryAddress: string; notes?: string },
  idempotencyKey: string,
): Promise<{ orderId: number; replayed: boolean }> {
  return db.transaction(async (trx) => {
    // Serialise submissions per customer so a double-click can't race past the idempotency check.
    await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [1001, user.id]);

    const existing = await trx('orders').where({ customer_id: user.id, idempotency_key: idempotencyKey }).first();
    if (existing) return { orderId: existing.id, replayed: true };

    const cart = await trx('cart_items').where({ customer_id: user.id }).orderBy('id');
    if (cart.length === 0) throw new AppError(422, 'CART_EMPTY', 'Add at least one item to your cart before submitting');

    const [order] = await trx('orders')
      .insert({
        customer_id: user.id,
        status: OrderStatus.SUBMITTED,
        budget_minor: input.budgetMinor,
        fee_minor: config.serviceFee,
        currency: config.currency,
        delivery_address: input.deliveryAddress,
        notes: input.notes ?? null,
        idempotency_key: idempotencyKey,
      })
      .returning('id');

    await trx('order_items').insert(
      cart.map((c) => ({ order_id: order.id, name: c.name, quantity: c.quantity, notes: c.notes })),
    );
    await trx('cart_items').where({ customer_id: user.id }).delete();
    await recordEvent(trx, order.id, 'ORDER_SUBMITTED', user, null, OrderStatus.SUBMITTED);
    return { orderId: order.id, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* MR-03: safe shopper assignment                                      */
/* ------------------------------------------------------------------ */

export async function acceptOrder(user: AuthUser, orderId: number): Promise<void> {
  await db.transaction(async (trx) => {
    // Conditional update: only one concurrent request can match status=SUBMITTED AND shopper_id IS NULL.
    const updated = await trx('orders')
      .where({ id: orderId, status: OrderStatus.SUBMITTED })
      .whereNull('shopper_id')
      .update({ shopper_id: user.id, status: OrderStatus.ASSIGNED, updated_at: trx.fn.now() })
      .returning('id');

    if (updated.length === 0) {
      const order = await trx<OrderRow>('orders').where({ id: orderId }).first();
      if (!order) throw notFound('Order');
      if (order.shopper_id !== null) {
        throw new AppError(409, 'ALREADY_ASSIGNED', 'Another shopper has already accepted this order', {
          currentStatus: order.status,
        });
      }
      throw invalidTransition(order, OrderStatus.ASSIGNED);
    }
    await recordEvent(trx, orderId, 'SHOPPER_ASSIGNED', user, OrderStatus.SUBMITTED, OrderStatus.ASSIGNED);
  });
}

/* ------------------------------------------------------------------ */
/* MR-04: proposals and approval                                       */
/* ------------------------------------------------------------------ */

export interface ProposalLineInput {
  orderItemId: number;
  kind: 'AS_REQUESTED' | 'SUBSTITUTE' | 'UNAVAILABLE';
  name?: string;
  quantity: number;
  unitPriceMinor: number;
  note?: string;
}

export async function createProposal(user: AuthUser, orderId: number, lines: ProposalLineInput[]) {
  return db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertAssignedShopper(order, user);
    if (!PROPOSABLE.includes(order.status)) {
      throw invalidTransition(order, OrderStatus.AWAITING_APPROVAL, `Cannot propose while order is ${order.status}`);
    }

    const items = await trx('order_items').where({ order_id: orderId });
    const itemIds = new Set(items.map((i) => i.id));
    const seen = new Set<number>();
    for (const line of lines) {
      if (!itemIds.has(line.orderItemId)) {
        throw new AppError(422, 'UNKNOWN_ORDER_ITEM', `Order item ${line.orderItemId} does not belong to this order`);
      }
      if (seen.has(line.orderItemId)) {
        throw new AppError(422, 'DUPLICATE_ORDER_ITEM', `Order item ${line.orderItemId} appears more than once`);
      }
      seen.add(line.orderItemId);
    }
    if (seen.size !== items.length) {
      throw new AppError(422, 'INCOMPLETE_PROPOSAL', 'Every requested item needs a line (use UNAVAILABLE if not found)');
    }

    const normalised = lines.map((l) => {
      const item = items.find((i) => i.id === l.orderItemId)!;
      const unavailable = l.kind === 'UNAVAILABLE';
      if (l.kind === 'SUBSTITUTE' && !l.name) {
        throw new AppError(422, 'SUBSTITUTE_NAME_REQUIRED', 'A substitute line needs the substitute product name');
      }
      return {
        order_item_id: l.orderItemId,
        kind: l.kind,
        name: l.kind === 'SUBSTITUTE' ? l.name! : item.name,
        quantity: unavailable ? 0 : l.quantity,
        unit_price_minor: unavailable ? 0 : l.unitPriceMinor,
        note: l.note ?? null,
      };
    });

    const goods = normalised.reduce((sum, l) => sum + l.quantity * l.unit_price_minor, 0);
    if (goods === 0) {
      throw new AppError(422, 'NOTHING_TO_BUY', 'At least one item must be available; cancel the order otherwise');
    }
    const hasSubstitute = normalised.some((l) => l.kind === 'SUBSTITUTE');
    const overBudget = goods > order.budget_minor;
    const requiresApproval = hasSubstitute || overBudget;

    // Supersede the previous proposal; any approval attached to it can no longer authorise a purchase.
    let version = 1;
    if (order.current_proposal_id) {
      const prev = await trx('proposals').where({ id: order.current_proposal_id }).first();
      version = prev.version + 1;
      await trx('proposals').where({ id: prev.id }).update({ status: 'SUPERSEDED' });
    }

    const [proposal] = await trx('proposals')
      .insert({
        order_id: orderId,
        version,
        status: requiresApproval ? 'PENDING' : 'APPROVED',
        goods_total_minor: goods,
        fee_minor: order.fee_minor,
        total_minor: goods + order.fee_minor,
        requires_customer_approval: requiresApproval,
        created_by: user.id,
      })
      .returning('*');
    await trx('proposal_lines').insert(normalised.map((l) => ({ ...l, proposal_id: proposal.id })));

    const reason = [hasSubstitute && 'contains substitutions', overBudget && 'exceeds budget'].filter(Boolean).join(', ');
    if (requiresApproval) {
      await transition(trx, order, OrderStatus.AWAITING_APPROVAL, user, 'PROPOSAL_SUBMITTED',
        `Proposal v${version} needs customer approval (${reason})`, { current_proposal_id: proposal.id });
    } else {
      await trx('approvals').insert({
        order_id: orderId,
        proposal_id: proposal.id,
        approved_amount_minor: proposal.total_minor,
        method: 'AUTO',
        approved_by: null,
      });
      await transition(trx, order, OrderStatus.APPROVED, null, 'PROPOSAL_AUTO_APPROVED',
        `Proposal v${version} within budget with no substitutions`, { current_proposal_id: proposal.id });
    }
    return proposal;
  });
}

export async function approveProposal(user: AuthUser, orderId: number, proposalId: number, version: number) {
  await db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertOwner(order, user);
    if (order.status !== OrderStatus.AWAITING_APPROVAL) {
      throw invalidTransition(order, OrderStatus.APPROVED, `There is no proposal awaiting approval (order is ${order.status})`);
    }
    const proposal = await trx('proposals').where({ id: order.current_proposal_id }).first();
    // The customer approves the exact version they looked at. Anything else is stale.
    if (!proposal || proposal.id !== proposalId || proposal.version !== version || proposal.status !== 'PENDING') {
      throw new AppError(409, 'STALE_PROPOSAL', 'The proposal has changed since you viewed it; review the latest version', {
        currentProposalId: proposal?.id ?? null,
        currentVersion: proposal?.version ?? null,
      });
    }
    await trx('proposals').where({ id: proposal.id }).update({ status: 'APPROVED' });
    await trx('approvals').insert({
      order_id: orderId,
      proposal_id: proposal.id,
      approved_amount_minor: proposal.total_minor,
      method: 'CUSTOMER',
      approved_by: user.id,
    });
    await transition(trx, order, OrderStatus.APPROVED, user, 'PROPOSAL_APPROVED',
      `Approved proposal v${proposal.version} for ${proposal.total_minor}`);
  });
}

export async function rejectProposal(user: AuthUser, orderId: number, proposalId: number, reason?: string) {
  await db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertOwner(order, user);
    if (order.status !== OrderStatus.AWAITING_APPROVAL) {
      throw invalidTransition(order, OrderStatus.PROPOSAL_REJECTED, `There is no proposal awaiting a decision (order is ${order.status})`);
    }
    if (order.current_proposal_id !== proposalId) {
      throw new AppError(409, 'STALE_PROPOSAL', 'The proposal has changed since you viewed it', {
        currentProposalId: order.current_proposal_id,
      });
    }
    await trx('proposals').where({ id: proposalId }).update({ status: 'REJECTED', rejection_reason: reason ?? null });
    await transition(trx, order, OrderStatus.PROPOSAL_REJECTED, user, 'PROPOSAL_REJECTED', reason);
  });
}

/* ------------------------------------------------------------------ */
/* MR-05: purchase records and receipts                                */
/* ------------------------------------------------------------------ */

export interface PurchaseInput {
  storeName: string;
  receiptNumber: string;
  receiptNote?: string;
  lines: { proposalLineId: number; quantity: number; unitPriceMinor: number }[];
}

export async function recordPurchase(user: AuthUser, orderId: number, input: PurchaseInput) {
  return db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertAssignedShopper(order, user);
    if (order.status !== OrderStatus.APPROVED) {
      throw invalidTransition(order, OrderStatus.PURCHASED,
        order.status === OrderStatus.AWAITING_APPROVAL
          ? 'Purchasing is blocked until the customer approves the current proposal'
          : `Cannot record a purchase while order is ${order.status}`);
    }

    const proposal = await trx('proposals').where({ id: order.current_proposal_id }).first();
    const approval = proposal && (await trx('approvals').where({ proposal_id: proposal.id }).first());
    if (!proposal || proposal.status !== 'APPROVED' || !approval) {
      throw new AppError(409, 'NO_VALID_APPROVAL', 'The current proposal has no approval');
    }

    const proposalLines = await trx('proposal_lines').where({ proposal_id: proposal.id });
    const seen = new Set<number>();
    const lines = input.lines.map((l) => {
      const pl = proposalLines.find((p) => p.id === l.proposalLineId);
      if (!pl) throw new AppError(422, 'UNKNOWN_PROPOSAL_LINE', `Line ${l.proposalLineId} is not part of the approved proposal`);
      if (seen.has(pl.id)) throw new AppError(422, 'DUPLICATE_LINE', `Line ${pl.id} appears more than once`);
      seen.add(pl.id);
      if (pl.kind === 'UNAVAILABLE') throw new AppError(422, 'LINE_UNAVAILABLE', `Line ${pl.id} was marked unavailable`);
      if (l.quantity > pl.quantity) {
        throw new AppError(422, 'QUANTITY_EXCEEDS_PROPOSAL', `Cannot buy more of "${pl.name}" than was approved (${pl.quantity})`);
      }
      return {
        proposal_line_id: pl.id,
        name: pl.name,
        quantity: l.quantity,
        unit_price_minor: l.unitPriceMinor,
        line_total_minor: l.quantity * l.unitPriceMinor,
      };
    });

    // Server-calculated totals: the client never sends a total.
    const goods = lines.reduce((s, l) => s + l.line_total_minor, 0);
    const finalTotal = goods + order.fee_minor;
    if (finalTotal > approval.approved_amount_minor) {
      throw new AppError(422, 'EXCEEDS_APPROVED_AMOUNT', 'The final total exceeds the amount the customer approved', {
        finalTotalMinor: finalTotal,
        approvedAmountMinor: approval.approved_amount_minor,
      });
    }

    const [purchase] = await trx('purchases')
      .insert({
        order_id: orderId,
        proposal_id: proposal.id,
        approval_id: approval.id,
        store_name: input.storeName,
        receipt_number: input.receiptNumber,
        receipt_note: input.receiptNote ?? null,
        goods_total_minor: goods,
        fee_minor: order.fee_minor,
        final_total_minor: finalTotal,
        recorded_by: user.id,
      })
      .returning('*');
    await trx('purchase_lines').insert(lines.map((l) => ({ ...l, purchase_id: purchase.id })));
    await transition(trx, order, OrderStatus.PURCHASED, user, 'PURCHASE_RECORDED',
      `Receipt ${input.receiptNumber} from ${input.storeName}`,
      { goods_total_minor: goods, final_total_minor: finalTotal });
    return purchase;
  });
}

/* ------------------------------------------------------------------ */
/* MR-08: simulated payments                                           */
/* ------------------------------------------------------------------ */

export async function payOrder(
  user: AuthUser,
  orderId: number,
  outcome: 'success' | 'failure',
  idempotencyKey: string,
): Promise<{ payment: Record<string, unknown>; replayed: boolean }> {
  return db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertOwner(order, user);

    // Same key = same request: return the original result, never charge twice.
    const replay = await trx('payments').where({ order_id: orderId, idempotency_key: idempotencyKey }).first();
    if (replay) return { payment: replay, replayed: true };

    const succeeded = await trx('payments').where({ order_id: orderId, status: 'SUCCEEDED' }).first();
    if (succeeded) {
      throw new AppError(409, 'ALREADY_PAID', 'This order has already been paid', { paymentId: succeeded.id });
    }
    if (order.status !== OrderStatus.PURCHASED) {
      throw invalidTransition(order, OrderStatus.PAID, `Payment is only possible after purchase (order is ${order.status})`);
    }

    const ok = outcome === 'success';
    const [payment] = await trx('payments')
      .insert({
        order_id: orderId,
        amount_minor: order.final_total_minor,
        currency: order.currency,
        status: ok ? 'SUCCEEDED' : 'FAILED',
        failure_reason: ok ? null : 'Simulated decline',
        idempotency_key: idempotencyKey,
        simulated_reference: `SIM-${crypto.randomUUID()}`,
        initiated_by: user.id,
      })
      .returning('*');

    if (ok) {
      await transition(trx, order, OrderStatus.PAID, user, 'PAYMENT_SUCCEEDED', `Payment #${payment.id}`);
    } else {
      await recordEvent(trx, orderId, 'PAYMENT_FAILED', user, order.status, order.status, `Payment #${payment.id}: simulated decline`);
    }
    return { payment, replayed: false };
  });
}

/* ------------------------------------------------------------------ */
/* MR-06: delivery                                                     */
/* ------------------------------------------------------------------ */

export async function markOutForDelivery(user: AuthUser, orderId: number) {
  await db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertAssignedShopper(order, user);
    if (order.status !== OrderStatus.PAID) {
      throw invalidTransition(order, OrderStatus.OUT_FOR_DELIVERY,
        order.status === OrderStatus.PURCHASED
          ? 'Dispatch is blocked until payment succeeds'
          : `Cannot dispatch while order is ${order.status}`);
    }
    await transition(trx, order, OrderStatus.OUT_FOR_DELIVERY, user, 'OUT_FOR_DELIVERY');
  });
}

export async function markDelivered(user: AuthUser, orderId: number) {
  await db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertAssignedShopper(order, user);
    await transition(trx, order, OrderStatus.DELIVERED, user, 'DELIVERED');
  });
}

export async function confirmReceipt(user: AuthUser, orderId: number) {
  await db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertOwner(order, user);
    await transition(trx, order, OrderStatus.COMPLETED, user, 'RECEIPT_CONFIRMED');
  });
}

/* ------------------------------------------------------------------ */
/* MR-07: cancellation and issues                                      */
/* ------------------------------------------------------------------ */

export async function cancelOrder(user: AuthUser, orderId: number, reason?: string) {
  await db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertOwner(order, user);
    if (!CANCELLABLE.includes(order.status)) {
      throw invalidTransition(order, OrderStatus.CANCELLED,
        ISSUE_REPORTABLE.includes(order.status)
          ? 'Items have already been purchased; report an issue instead of cancelling'
          : `Cannot cancel while order is ${order.status}`);
    }
    if (order.current_proposal_id) {
      await trx('proposals').where({ id: order.current_proposal_id }).whereIn('status', ['PENDING']).update({ status: 'SUPERSEDED' });
    }
    // Nothing purchased, so no fee and no payment is ever taken.
    await transition(trx, order, OrderStatus.CANCELLED, user, 'ORDER_CANCELLED', reason ?? 'Cancelled by customer (no charge)');
  });
}

export async function reportIssue(user: AuthUser, orderId: number, description: string) {
  return db.transaction(async (trx) => {
    const order = await lockOrder(trx, orderId);
    assertOwner(order, user);
    if (!ISSUE_REPORTABLE.includes(order.status)) {
      throw new AppError(409, 'ISSUE_NOT_ALLOWED',
        'Issues can be reported once items have been purchased; before that, cancel the order instead',
        { currentStatus: order.status });
    }
    const [issue] = await trx('issues')
      .insert({ order_id: orderId, reported_by: user.id, description, status: 'OPEN' })
      .returning('*');
    await trx('orders').where({ id: orderId }).update({ has_open_issue: true, updated_at: trx.fn.now() });
    await recordEvent(trx, orderId, 'ISSUE_REPORTED', user, order.status, order.status, `Issue #${issue.id}`);
    return issue;
  });
}

export async function resolveIssue(user: AuthUser, issueId: number, resolutionNotes: string) {
  return db.transaction(async (trx) => {
    const issue = await trx('issues').where({ id: issueId }).forUpdate().first();
    if (!issue) throw notFound('Issue');
    if (issue.status !== 'OPEN') {
      throw new AppError(409, 'ISSUE_ALREADY_RESOLVED', 'This issue has already been resolved');
    }
    const [updated] = await trx('issues')
      .where({ id: issueId })
      .update({ status: 'RESOLVED', resolution_notes: resolutionNotes, resolved_by: user.id, resolved_at: trx.fn.now() })
      .returning('*');
    const open = await trx('issues').where({ order_id: issue.order_id, status: 'OPEN' }).count<{ count: string }[]>('id as count');
    await trx('orders').where({ id: issue.order_id }).update({ has_open_issue: Number(open[0].count) > 0 });
    const order = await trx('orders').where({ id: issue.order_id }).first();
    await recordEvent(trx, issue.order_id, 'ISSUE_RESOLVED', user, order.status, order.status, `Issue #${issueId} resolved`);
    return updated;
  });
}

/* ------------------------------------------------------------------ */
/* Reads (MR-06 history and breakdown)                                 */
/* ------------------------------------------------------------------ */

export async function getOrderDetail(user: AuthUser, orderId: number) {
  const order = await db<OrderRow>('orders').where({ id: orderId }).first();
  if (!order) throw notFound('Order');
  if (!canView(order, user)) throw forbidden('You cannot view this order');

  const [items, customer, shopper, proposals, purchase, payments, events, issues] = await Promise.all([
    db('order_items').where({ order_id: orderId }).orderBy('id'),
    db('users').select('id', 'name').where({ id: order.customer_id }).first(),
    order.shopper_id ? db('users').select('id', 'name').where({ id: order.shopper_id }).first() : null,
    db('proposals').where({ order_id: orderId }).orderBy('version'),
    db('purchases').where({ order_id: orderId }).first(),
    db('payments').where({ order_id: orderId }).orderBy('id'),
    db('order_events as e')
      .leftJoin('users as u', 'u.id', 'e.actor_id')
      .select('e.*', 'u.name as actor_name')
      .where({ 'e.order_id': orderId })
      .orderBy('e.id'),
    db('issues').where({ order_id: orderId }).orderBy('id'),
  ]);

  const current = proposals.find((p) => p.id === order.current_proposal_id) ?? null;
  const currentProposal = current
    ? {
        ...current,
        lines: await db('proposal_lines').where({ proposal_id: current.id }).orderBy('id'),
        approval: (await db('approvals').where({ proposal_id: current.id }).first()) ?? null,
      }
    : null;
  const purchaseDetail = purchase
    ? { ...purchase, lines: await db('purchase_lines').where({ purchase_id: purchase.id }).orderBy('id') }
    : null;

  // Shoppers browsing an unassigned request see what they need to decide, not the full record.
  const isBrowsingShopper = user.role === 'shopper' && order.shopper_id !== user.id;

  return {
    ...order,
    customer,
    shopper,
    items,
    currentProposal,
    proposalHistory: proposals.map((p) => ({ id: p.id, version: p.version, status: p.status, total_minor: p.total_minor })),
    purchase: purchaseDetail,
    payments: isBrowsingShopper ? [] : payments,
    events: isBrowsingShopper ? [] : events,
    issues: isBrowsingShopper ? [] : issues,
  };
}

export async function listOrders(user: AuthUser, status?: string) {
  const q = db('orders as o')
    .leftJoin('users as c', 'c.id', 'o.customer_id')
    .leftJoin('users as s', 's.id', 'o.shopper_id')
    .select('o.*', 'c.name as customer_name', 's.name as shopper_name')
    .orderBy('o.id', 'desc');
  if (user.role === 'customer') q.where('o.customer_id', user.id);
  if (user.role === 'shopper') q.where('o.shopper_id', user.id);
  if (status) q.where('o.status', status);
  const orders = await q;
  const counts = orders.length
    ? await db('order_items').select('order_id').count('id as item_count').whereIn('order_id', orders.map((o) => o.id)).groupBy('order_id')
    : [];
  return orders.map((o) => ({ ...o, item_count: Number(counts.find((c) => c.order_id === o.id)?.item_count ?? 0) }));
}

export async function listAvailableOrders() {
  const orders = await db('orders')
    .select('id', 'status', 'budget_minor', 'fee_minor', 'currency', 'delivery_address', 'notes', 'created_at')
    .where({ status: OrderStatus.SUBMITTED })
    .whereNull('shopper_id')
    .orderBy('id');
  const items = orders.length ? await db('order_items').whereIn('order_id', orders.map((o) => o.id)).orderBy('id') : [];
  return orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) }));
}
