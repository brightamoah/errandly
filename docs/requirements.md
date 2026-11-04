# Requirements, user stories and acceptance criteria

This maps MR-01 to MR-08 to user stories and testable acceptance criteria (Week 1 deliverable). Each criterion names the automated test that proves it.

## Assumptions about MR-01 to MR-05

The copy of the brief this was built from begins partway through MR-05. The text of MR-01 to MR-04 and the start of MR-05 was not available, so those requirements were **inferred** from the milestone table ("accounts, cart, order submission and safe shopper assignment (MR-01–03)", "proposals, customer approval, purchase records, receipts (MR-04–05)"), the acceptance scenarios, and the surviving MR-05 lines. Check each assumption below against the full brief and adjust.

| ID | Inferred requirement | Key assumption |
|---|---|---|
| MR-01 | Accounts and roles | Three roles: customer, shopper, administrator. Customers and shoppers self-register; administrators are provisioned (seeded), never self-registered. |
| MR-02 | Cart and order submission | The customer builds a server-side cart, then submits it with a **goods budget** and delivery address. The service fee is fixed at submission and stored on the order. |
| MR-03 | Shopper assignment | Shoppers see open requests and accept one. Exactly one shopper can win a request. |
| MR-04 | Proposals and approval | The shopper prices each item as found, substituted, or unavailable. Substitutions or going over budget require customer approval; the approval is bound to one proposal version and amount. |
| MR-05 | Purchase records and receipts | The shopper records what was bought, with store and receipt number. Goods totals are calculated by the server, and the final total (goods + stored fee) cannot exceed the approved amount. *(The last two sentences are from the brief.)* |

Design decision on MR-04: a proposal **within budget with no substitutions is approved automatically** (recorded as a system approval). This keeps the common case fast, while every case the brief calls out (swaps, over budget, changed proposals) still blocks purchase until the customer approves. If the full brief requires customer approval for every proposal, change `requiresApproval` in `src/services/orders.ts` to `true`; tests AS-1 and the MR-04 auto-approve test would then need an approve step.

## User stories

### MR-01 Accounts and roles
**US-1.1** As a customer or shopper, I can create an account and sign in, so the system knows who I am and what I may do.
- AC: Registration requires a valid unique email, a password of 8+ characters, a name, and role `customer` or `shopper`. *(auth-permissions: register / duplicate email, weak password)*
- AC: Nobody can self-register as `admin`. *(auth-permissions: nobody can self-register as admin)*
- AC: Requests without a valid token get `401 UNAUTHENTICATED`; tokens with a forged signature are rejected. *(auth-permissions: missing, malformed and forged tokens)*
- AC: Each endpoint is limited to the roles that need it; others get `403 FORBIDDEN`. *(auth-permissions: roles are enforced)*

### MR-02 Cart and order submission
**US-2.1** As a customer, I can add, change and remove items in my shopping list.
- AC: Cart items are private to their owner; another customer gets `404` editing them. *(business-rules: cart is private)*

**US-2.2** As a customer, I can submit my list with a goods budget and delivery address.
- AC: An empty cart cannot be submitted (`422 CART_EMPTY`). *(business-rules: empty cart)*
- AC: The service fee is stored on the order at submission; the cart is emptied into order items. *(business-rules: fee is stored)*
- AC: Submitting twice with the same `Idempotency-Key`, including concurrently, creates one order. *(business-rules: repeated submission)*

### MR-03 Shopper assignment
**US-3.1** As a shopper, I can see open requests and accept one.
- AC: Shoppers see unassigned requests with items, budget and address, but not the customer's history. *(auth-permissions: shoppers see unassigned requests)*
- AC: When two shoppers accept at the same moment, exactly one is assigned; the other gets `409 ALREADY_ASSIGNED`. *(acceptance: AS-2, run five times)*

### MR-04 Proposals and approval
**US-4.1** As a shopper, I can price every item as found, swapped, or unavailable.
- AC: The proposal must cover every requested item exactly once. *(business-rules: proposal must cover every item)*
- AC: Unavailable items cost nothing. *(business-rules: unavailable items cost nothing)*

**US-4.2** As a customer, I approve swaps or over-budget totals before anything is bought.
- AC: A proposal with a swap or over budget moves the order to `AWAITING_APPROVAL`; purchase is refused until approved. *(acceptance: AS-3)*
- AC: Approval names the exact proposal id and version; a mismatch is `409 STALE_PROPOSAL`. *(business-rules: wrong version)*
- AC: Changing a proposal after approval supersedes it; the old approval can't authorise the new purchase or be re-used. *(acceptance: AS-4)*
- AC: A rejected proposal can be revised. *(business-rules: rejected proposal can be revised)*

### MR-05 Purchase records and receipts
**US-5.1** As a shopper, I record what I bought with the store and receipt number.
- AC: The client sends quantities and unit prices only; totals are calculated by the server, and a client-sent total is rejected. *(business-rules: server calculates totals)*
- AC: The final total cannot exceed the approved amount (`422 EXCEEDS_APPROVED_AMOUNT`). *(business-rules: final total cannot exceed)*
- AC: Quantities can't exceed the approved proposal; a purchase can only be recorded once, even concurrently. *(business-rules: cannot buy more…)*

### MR-06 Delivery and history
**US-6.1** As a shopper, I mark the order out for delivery, then delivered. As a customer, I confirm receipt to complete it.
- AC: Steps can't be skipped or repeated; only the customer can confirm. *(business-rules: cannot skip steps)*
- AC: Both parties see the item breakdown, final total, receipt and timestamped history. *(acceptance: AS-1)*
- AC: Every status change records who made it and when; automatic approvals are recorded as `system`. *(business-rules: every status change records who)*

### MR-07 Cancellation and issues
**US-7.1** As a customer, I can cancel before anything is bought, at no charge.
- AC: Cancel is allowed in `SUBMITTED`, `ASSIGNED`, `AWAITING_APPROVAL`, `PROPOSAL_REJECTED`, `APPROVED`; no payment or fee is taken. *(business-rules: customer can cancel; rejected proposal can be cancelled)*

**US-7.2** After purchase, I report an issue instead of cancelling; an administrator reviews it.
- AC: Cancelling after purchase returns `409` telling the customer to report an issue. *(business-rules: after purchase…)*
- AC: Issues can't be reported before purchase. *(business-rules: issues cannot be reported before purchase)*
- AC: Issue text and resolution notes are stored; only admins resolve; an issue resolves once. *(business-rules: after purchase…)*

### MR-08 Simulated payments
**US-8.1** As a customer, I pay the final total before dispatch, and can retry a failed payment.
- AC: Payment is only possible after purchase, for the server's final total (a client-sent amount is ignored). *(business-rules: cannot pay before purchase; charges the server-calculated total)*
- AC: Dispatch is blocked until a payment succeeds. *(acceptance: AS-6)*
- AC: Retrying with the same key returns the original result; concurrent attempts with different keys still produce exactly one successful payment, enforced by a database unique index. *(acceptance: AS-6, AS-6b)*

## Acceptance scenarios

| Scenario from the brief | Test |
|---|---|
| Three items fulfilled, paid, confirmed; completed with correct total and history | `AS-1` |
| Two shoppers accept simultaneously; exactly one assigned | `AS-2` |
| Substitute above budget; purchasing blocked until customer approves | `AS-3` |
| Proposal changed after approval; old approval can't authorise it | `AS-4` |
| Customer can't read another's order; unassigned shopper can't change status | `AS-5` |
| Payment fails and is retried; dispatch blocked; one successful payment | `AS-6`, `AS-6b` |

## Out of scope (from the brief)
Live GPS tracking, real payments and refunds, multi-shopper fulfilment, recurring orders, automated price discovery, merchant inventory integration, ratings, route optimisation.
