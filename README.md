# Errandly

A personal shopping and delivery service. A customer writes a shopping list and sets a budget; a shopper accepts the job, prices the list, checks any swaps or overspend with the customer, buys the items, records the receipt, and delivers. Payments are simulated.

- **Backend:** Node 20+, Express, TypeScript, PostgreSQL (knex for queries and migrations), JWT auth, zod validation
- **Interface:** React + Vite, one view per role (customer, shopper, administrator)
- **API docs:** OpenAPI 3 at [`docs/openapi.yaml`](docs/openapi.yaml), served interactively at `/docs`
- **Tests:** 35 Jest + Supertest tests against a real PostgreSQL database, including all six acceptance scenarios and the concurrency races

| Document | Contents |
|---|---|
| [`docs/requirements.md`](docs/requirements.md) | MR-01–08 as user stories and acceptance criteria, each mapped to a test; assumptions |
| [`docs/architecture.md`](docs/architecture.md) | Status model, data model, integrity and concurrency decisions, tradeoffs, limitations |
| [`docs/project-plan.md`](docs/project-plan.md) | Weekly plan and evidence map, demo script, defect log, decision notes |
| [`docs/screenshots/`](docs/screenshots) | Interface screenshots for each role |

## Run it locally

Prerequisites: Node 20 or newer and PostgreSQL 14 or newer (or Docker).

```bash
# 1. Install
pnpm install
pnpm --prefix web install

# 2. Configure
cp .env.example .env            # then edit DATABASE_URL, TEST_DATABASE_URL, JWT_SECRET
createdb errands
createdb errands_test

# 3. Migrate and load demo accounts
pnpm run db migrate
pnpm run db seed

# 4. Start (two terminals)
pnpm run dev                     # API on http://localhost:3000
pnpm run dev:web                 # interface on http://localhost:5173 (proxies /api)
```

Or with Docker, which builds everything and serves it on http://localhost:3000:

```bash
docker compose up --build
docker compose exec app node dist/scripts/db.js seed
```

## Demo accounts

All demo accounts use the password **`Demo1234!`**. The sign-in screen also has one-click demo buttons.

| Role | Email | Notes |
|---|---|---|
| Customer | `customer@errandly.test` | Shopping list is pre-filled so you can place an order straight away |
| Customer | `customer2@errandly.test` | Use to show one customer can't see another's orders |
| Shopper | `shopper@errandly.test` | |
| Shopper | `shopper2@errandly.test` | Use to show the accept-at-the-same-time conflict |
| Administrator | `admin@errandly.test` | Reviews and resolves issues |

Administrators cannot self-register; they are created by the seed (or directly in the database).

## Configuration variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes in production | local `errands` db | PostgreSQL connection string |
| `TEST_DATABASE_URL` | For tests | local `errands_test` db | Separate database; tests truncate it |
| `JWT_SECRET` | Yes in production | dev-only value | Signs access tokens. Use a long random value (`openssl rand -hex 32`) |
| `JWT_EXPIRES_IN` | No | `12h` | Token lifetime |
| `SERVICE_FEE_MINOR` | No | `1500` | Service fee in minor units, stored on each order at submission |
| `CURRENCY` | No | `GHS` | Currency code shown and stored on orders |
| `PORT` | No | `3000` | HTTP port |
| `DATABASE_SSL` | No | `false` | `true` for hosted databases that require SSL |
| `MIGRATE_ON_START` | No | `false` | Apply pending migrations when the server starts |
| `ALLOW_SEED` | No | `false` | Permit seeding when `NODE_ENV=production` (demo environments only; seeding wipes data) |

Secrets are read only from the environment. `.env` is git-ignored, and request logs contain method, path, status and timing only: no headers, bodies or tokens.

## Database migrations

| Command | Effect |
|---|---|
| `pnpm run db migrate` | Apply pending migrations |
| `pnpm run db rollback` | Undo the last batch |
| `pnpm run db seed` | **Wipe all data** and load demo accounts |
| `pnpm run db reset` | Roll back everything, migrate, seed |

After `pnpm run build`, use `pnpm run db:prod -- <command>` (compiled, no TypeScript tooling needed). Migrations live in `migrations/`; add a new numbered file for each schema change rather than editing an applied one.

## Tests

```bash
pnpm test
```

Runs against `TEST_DATABASE_URL` (migrated automatically, truncated before each file). Suites:

- `tests/acceptance.test.ts`: the six acceptance scenarios from the brief (AS-1 to AS-6, plus AS-6b for concurrent first payments)
- `tests/business-rules.test.ts`: cart, submission idempotency, proposals, server-side totals, approved-amount limit, delivery order, cancellation, issues, payments
- `tests/auth-permissions.test.ts`: registration, login, token validation, role enforcement, error format

## Deploy to the shared test environment

The app is one Docker image that serves the API, the docs and the interface.

**Render (blueprint included):** in Render, choose *New → Blueprint* and select this repository. `render.yaml` creates the web service and a PostgreSQL database, generates `JWT_SECRET`, and applies migrations on start. Then open the service's *Shell* and run `npm run db:prod -- seed` to load the demo accounts. Set `DATABASE_SSL=true` if the database rejects non-SSL connections.

**Any other host:** build with `docker build -t errandly .`, provide `DATABASE_URL`, `JWT_SECRET` and `MIGRATE_ON_START=true`, and expose port 3000. Health check: `GET /health`.

## API at a glance

Full reference with request and response examples: `/docs` on a running server, or [`docs/openapi.yaml`](docs/openapi.yaml) (import it into Postman via *Import → File*).

| Step | Endpoint | Who |
|---|---|---|
| Sign up / in | `POST /api/auth/register`, `POST /api/auth/login` | anyone |
| Build list | `GET /api/cart`, `POST/PATCH/DELETE /api/cart/items` | customer |
| Submit | `POST /api/orders` (needs `Idempotency-Key`) | customer |
| Find and accept | `GET /api/orders/available`, `POST /api/orders/{id}/accept` | shopper |
| Propose | `POST /api/orders/{id}/proposals` | assigned shopper |
| Decide | `POST /api/orders/{id}/proposals/{pid}/approve` or `/reject` | customer |
| Buy | `POST /api/orders/{id}/purchase` | assigned shopper |
| Pay | `POST /api/orders/{id}/payments` (needs `Idempotency-Key`) | customer |
| Deliver | `POST /api/orders/{id}/out-for-delivery`, `/delivered` | assigned shopper |
| Complete | `POST /api/orders/{id}/confirm-receipt` | customer |
| Cancel / report | `POST /api/orders/{id}/cancel`, `/issues` | customer |
| Review | `GET /api/admin/issues`, `POST /api/admin/issues/{id}/resolve` | administrator |
| View | `GET /api/orders`, `GET /api/orders/{id}` | all, scoped by role |

## Project layout

```
src/
  domain/orderStatus.ts   status model and allowed transitions
  services/orders.ts      all business rules, one transaction per action
  routes/index.ts         HTTP endpoints, validation, role checks
  auth.ts, errors.ts      JWT auth and the error format
migrations/               schema (knex)
seeds/                    demo accounts
tests/                    Jest + Supertest
web/                      React interface
docs/                     requirements, architecture, plan, OpenAPI, screenshots
```

## Known limitations

See [`docs/architecture.md`](docs/architecture.md#tradeoffs-and-limitations). In short: the interface refreshes after actions rather than updating live; receipts are recorded as store, number and note rather than uploaded images; issue resolution records notes only (no refunds, per the brief); tokens are kept in `localStorage`, which suits a test environment but not production.
