# Project plan, evidence map and logs

Individual project: all tasks are owned by JK. Commit history is the traceable record of contribution.

## Week-by-week plan and evidence

| Week | Milestone (grading weight) | Tasks | Evidence in this repository |
|---|---|---|---|
| 1 | Requirements and approach (10%) | Map MR-01–08 to stories; design status model, data model, API contract; plan | `docs/requirements.md`, `docs/architecture.md`, `docs/openapi.yaml`, this plan |
| 2 | Prototype (10%) | Accounts, cart, submission, safe assignment (MR-01–03) | `src/routes`, `migrations/`, tests: auth-permissions, MR-02 group, AS-2 |
| 3 | Core functionality (**40%**) | Proposals, approval, purchase, receipts, simulated payment (MR-04, 05, 08) | `src/services/orders.ts`, tests: MR-04/05/08 groups, AS-3, AS-4, AS-6 |
| 4 | Integration (10%) | Delivery, confirm receipt, cancellation, issues (MR-06–07); interface; deploy | `web/`, tests: MR-06/07 groups, screenshots, deployed link |
| 5 | Testing and documentation (10%) | Regression, permissions, concurrency, retries; fix defects; setup docs | `npm test` output, defect log below, `README.md` |
| 6 | Final demo (20%) | End-to-end demo plus substitution, conflict and failed-payment scenarios | Demo script below |

## Presentation demo script (Week 6)

Run `npm run db -- reset` first. Use three browser windows (or one normal, two private).

1. **Happy path (AS-1).** Customer: list is pre-filled → set budget GHS 150 → *Place order*. Shopper: *Open requests* → *Accept job* → enter prices within budget → *Confirm and start shopping* (auto-approved) → record purchase. Customer: *Pay now*. Shopper: *Set off* → *Mark as delivered*. Customer: *Confirm receipt*. Show the receipt and history on both sides.
2. **Substitution over budget (AS-3, AS-4).** New order. Shopper: mark an item *Swap for…* above budget → *Send for approval*. Show purchase blocked. Customer approves. Shopper: *Change the proposal instead*. Show the order back in *Needs approval* and the v1 approval superseded.
3. **Failed payment (AS-6).** After purchase, customer: *Simulate a declined payment* → show dispatch blocked for the shopper → *Pay now* → one *Payment OK* line and the PAID stamp.
4. **Conflict (AS-2).** Show the concurrency test: `npx jest -t "AS-2"`. Explain the conditional update.
5. **Permissions (AS-5).** Sign in as the second customer and open `/orders/1`: "You cannot view this order".
6. **Issue.** On a purchased order, customer reports a problem; admin resolves it with notes.

## Defect and fix log

| # | Found by | Defect | Fix |
|---|---|---|---|
| 1 | Test run | ts-jest failed to load: TypeScript 7 no longer exposes the compiler API ts-jest needs | Pinned `typescript@5` in dev dependencies |
| 2 | Test run | "final total cannot exceed" test expected the wrong total (test arithmetic, not code) | Corrected expectation to 5000 + 2000 + 3000 + fee |
| 3 | Visual review | Buttons inside action panels stretched to full width | `.decision > button { align-self: flex-start }` |
| 4 | Frontend build | Vite template's `verbatimModuleSyntax` / `erasableSyntaxOnly` rejected type imports and the `ApiError` parameter properties | Relaxed both flags in `web/tsconfig.app.json` |

Add new rows as defects are found during Weeks 5–6.

## Decision notes

| Date | Decision | Why |
|---|---|---|
| Week 1 | Node + Express + TypeScript + PostgreSQL via knex | Pure-JS driver, no engine downloads; explicit SQL for locking and partial indexes |
| Week 1 | Integer minor units for money | Avoid floating-point rounding |
| Week 1 | Versioned proposals; approval bound to one version | Makes AS-4 a data-model guarantee, not a code convention |
| Week 1 | Auto-approve within budget with no swaps | Speed for the common case; see `requirements.md` |
| Week 3 | Partial unique index for successful payments | Database-level guarantee against double charging |
| Week 4 | One process serves API, docs and SPA | One deployable unit for the shared test environment |
