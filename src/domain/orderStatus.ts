/**
 * Order status model. Every status change in the system goes through
 * `assertTransition`, so an invalid change is rejected in one place.
 */
export const OrderStatus = {
  SUBMITTED: 'SUBMITTED', // waiting for a shopper
  ASSIGNED: 'ASSIGNED', // shopper accepted, no proposal yet
  AWAITING_APPROVAL: 'AWAITING_APPROVAL', // proposal needs customer decision
  PROPOSAL_REJECTED: 'PROPOSAL_REJECTED', // customer rejected; shopper may revise
  APPROVED: 'APPROVED', // current proposal approved; shopper may purchase
  PURCHASED: 'PURCHASED', // purchase + receipt recorded; awaiting payment
  PAID: 'PAID', // simulated payment succeeded
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED', // shopper says delivered; customer must confirm
  COMPLETED: 'COMPLETED', // customer confirmed receipt
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

const S = OrderStatus;

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  SUBMITTED: [S.ASSIGNED, S.CANCELLED],
  ASSIGNED: [S.AWAITING_APPROVAL, S.APPROVED, S.CANCELLED],
  AWAITING_APPROVAL: [S.APPROVED, S.PROPOSAL_REJECTED, S.AWAITING_APPROVAL, S.CANCELLED],
  PROPOSAL_REJECTED: [S.AWAITING_APPROVAL, S.APPROVED, S.CANCELLED],
  // Revising after approval supersedes the approval (back to AWAITING_APPROVAL / auto APPROVED).
  APPROVED: [S.PURCHASED, S.AWAITING_APPROVAL, S.APPROVED, S.CANCELLED],
  PURCHASED: [S.PAID],
  PAID: [S.OUT_FOR_DELIVERY],
  OUT_FOR_DELIVERY: [S.DELIVERED],
  DELIVERED: [S.COMPLETED],
  COMPLETED: [],
  CANCELLED: [],
};

/** Statuses in which nothing has been bought, so the customer may cancel at no charge. */
export const CANCELLABLE: OrderStatus[] = [
  S.SUBMITTED,
  S.ASSIGNED,
  S.AWAITING_APPROVAL,
  S.PROPOSAL_REJECTED,
  S.APPROVED,
];

/** Statuses from which a proposal may be (re)submitted. */
export const PROPOSABLE: OrderStatus[] = [S.ASSIGNED, S.AWAITING_APPROVAL, S.PROPOSAL_REJECTED, S.APPROVED];

/** After purchase the customer reports issues instead of cancelling. */
export const ISSUE_REPORTABLE: OrderStatus[] = [S.PURCHASED, S.PAID, S.OUT_FOR_DELIVERY, S.DELIVERED, S.COMPLETED];
