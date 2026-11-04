export type Role = 'customer' | 'shopper' | 'admin';
export interface User { id: number; email: string; name: string; role: Role }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const TOKEN_KEY = 'errandly.token';
export const tokenStore = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string | null) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } },
};

export async function api<T = any>(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const res = await fetch(`/api${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data;
}

export const newKey = () => crypto.randomUUID();

let currency = 'GHS';
export const setCurrency = (c: string) => { currency = c; };
export const money = (minor: number | null | undefined) =>
  minor == null ? '—' : `${currency} ${(minor / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const toMinor = (value: string) => Math.round(parseFloat(value || '0') * 100);
export const fromMinor = (minor: number) => (minor / 100).toFixed(2);

export const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: 'Waiting for a shopper',
  ASSIGNED: 'Shopper assigned',
  AWAITING_APPROVAL: 'Needs approval',
  PROPOSAL_REJECTED: 'Proposal rejected',
  APPROVED: 'Approved to shop',
  PURCHASED: 'Bought, awaiting payment',
  PAID: 'Paid',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const EVENT_LABEL: Record<string, string> = {
  ORDER_SUBMITTED: 'Order placed',
  SHOPPER_ASSIGNED: 'Shopper accepted',
  PROPOSAL_SUBMITTED: 'Proposal sent for approval',
  PROPOSAL_AUTO_APPROVED: 'Proposal approved automatically',
  PROPOSAL_APPROVED: 'Proposal approved',
  PROPOSAL_REJECTED: 'Proposal rejected',
  PURCHASE_RECORDED: 'Items bought',
  PAYMENT_SUCCEEDED: 'Payment succeeded',
  PAYMENT_FAILED: 'Payment failed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Marked delivered',
  RECEIPT_CONFIRMED: 'Receipt confirmed',
  ORDER_CANCELLED: 'Order cancelled',
  ISSUE_REPORTED: 'Issue reported',
  ISSUE_RESOLVED: 'Issue resolved',
};
