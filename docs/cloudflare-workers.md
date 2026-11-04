# Deploying Errandly to Cloudflare Workers

The API and the React interface are served from a single Worker:

```
Browser ──► Worker (errandly)
              ├── /api/*, /health, /docs, /openapi.json ──► Express (node:http) ──► Knex ──► Hyperdrive ──► PostgreSQL
              └── everything else ────────────────────────► Workers Assets (web/dist, SPA fallback)
```

Cloudflare Workers now runs Express through the `node:http` implementation
(`cloudflare:node`), so the application code is unchanged. What differs from the
Docker/Render deployment is only the platform plumbing:

| Piece | Docker / Render | Cloudflare Workers |
|---|---|---|
| HTTP server | Node `http` (`server.ts`) | `src/worker.ts` via `handleAsNodeRequest` |
| Static React files | `express.static` | Workers Assets (`assets` in `wrangler.jsonc`) |
| API reference | `swagger-ui-express` reading `docs/openapi.yaml` | spec inlined at build time, Swagger UI from CDN |
| Database | `pg` with `DATABASE_URL` | `pg` with the `HYPERDRIVE` binding, one Knex instance per request |
| Config | `.env` + `dotenv` | `vars`, `wrangler secret`, Hyperdrive binding |
| Migrations | `MIGRATE_ON_START=true` | run from your machine (Workers have no filesystem) |

## Files involved

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Worker name, entry point, Hyperdrive binding, assets, aliases |
| `src/worker.ts` | Worker entry: request-scoped Knex, then Express |
| `src/cf/app.ts` | Express app for Workers (no filesystem, no `swagger-ui-express`) |
| `src/db.ts` | `createKnex()` + request-scoped `db` proxy (Node and Workers share it) |
| `src/config.ts` | Lazy config that can be fed Workers bindings via `configure()` |
| `tsconfig.worker.json` | Type checking for the Worker-only files |
| `.dev.vars.example` | Template for `wrangler dev` local secrets |

## Prerequisites

- Node.js 20+ and this repository checked out.
- A Cloudflare account. Use the **Workers Paid** plan ($5/month): the free plan
  allows 10 ms of CPU per request, and a single `bcrypt` hash on sign-up or
  sign-in can exceed that. Hyperdrive is available on both plans.
- PostgreSQL reachable from the public internet over TCP 5432 and TLS — Neon,
  Supabase, Railway, AWS RDS, or any managed Postgres. Hyperdrive is the pooler,
  so use the **direct** connection string of your database.
- `npx wrangler login` once, on your machine.

## 1. Install dependencies

```bash
pnpm install
```

`wrangler` and `@cloudflare/workers-types` are dev dependencies; they are not
needed by the Docker/Node deployment.

## 2. Create the Hyperdrive configuration

Hyperdrive does the connection pooling, so give it the **direct** database
endpoint rather than a provider-side pooler.

### Neon

1. In the Neon Console, open **Connect** and select the branch, database and
   role Hyperdrive should use (this project uses the `errandly` database).
2. Uncheck **Connection pooling** and copy the string. It looks like:

   ```
   postgresql://USER:PASSWORD@ep-xxxxxx.c-9.us-east-2.aws.neon.tech/errandly?sslmode=require
   ```

   (The pooled variant has `-pooler` in the host. It works too, but Hyperdrive
   then pools a pool; Cloudflare recommends the direct endpoint.)
3. Create the config:

```bash
npx wrangler hyperdrive create errandly-db \
  --connection-string="postgresql://USER:PASSWORD@ep-xxxxxx.c-9.us-east-2.aws.neon.tech/errandly?sslmode=require" \
  --caching-disabled
```

`--caching-disabled` matters for this app. Hyperdrive caches `SELECT` responses
for 60 seconds by default and **does not invalidate them on writes**, so a list
fetched right after submitting or accepting an order could show stale data for
up to a minute. Connection pooling and fast connection setup still apply.

Neon notes:

- `sslmode=require` and `sslmode=verify-full` both work. `channel_binding=require`
  in Neon's default string is a libpq option; node-postgres ignores it, so it
  does not need removing.
- Hyperdrive keeps a small pool of connections open, which can stop a Neon free
  plan database from scaling to zero and will use compute hours while the Worker
  gets traffic. Add `--origin-connection-limit=5` if you want to be gentle.
- The `errandly-test` database used by Jest does not need its own Hyperdrive
  config; only the database the Worker serves needs one.

Wrangler prints an `id`. Put it in `wrangler.jsonc`:

```jsonc
"hyperdrive": [
  { "binding": "HYPERDRIVE", "id": "paste-the-id-here" }
]
```

You can also create the config in the dashboard (Storage & Databases →
Hyperdrive) and copy its ID.

If the config already exists but was created with the pooled host or with
caching on, update it in place (the binding ID stays the same):

```bash
npx wrangler hyperdrive update <HYPERDRIVE_ID> \
  --connection-string="postgresql://USER:PASSWORD@ep-xxxxxx.c-9.us-east-2.aws.neon.tech/errandly?sslmode=require" \
  --caching-disabled
```

Check what is deployed with `npx wrangler hyperdrive get <HYPERDRIVE_ID>`:
`"caching": { "disabled": false }` means read caching is on, and the host should
not contain `-pooler`.

## 3. Create the schema and demo data

Migrations run from your machine directly against the database; the Worker only
serves requests. PowerShell:

```powershell
$env:DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require"
$env:DATABASE_SSL="true"      # required by most hosted providers
$env:ALLOW_SEED="true"        # seeding wipes data; only for the demo environment

pnpm run db migrate
pnpm run db seed
```

bash/zsh:

```bash
export DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require"
export DATABASE_SSL=true
export ALLOW_SEED=true

pnpm run db migrate
pnpm run db seed
```

This creates the five demo accounts (`Demo1234!`) and a pre-filled cart for
`customer@errandly.test`.

With Neon, the connection string already in `.env` (the `-pooler` host, with
`DATABASE_SSL=true`) is the right one to use here: migrations and seeding are
short-lived CLI work, not Worker traffic. Hyperdrive is only in the path of the
deployed Worker.

## 4. Add the JWT secret

```bash
openssl rand -hex 32            # copy the value
npx wrangler secret put JWT_SECRET
```

Secrets are encrypted and only available to the Worker at runtime. `NODE_ENV`,
`CURRENCY` and `SERVICE_FEE_MINOR` are plain `vars` in `wrangler.jsonc`; change
them there if needed.

`DATABASE_URL` is deliberately **not** a secret here: the Worker receives the
connection string from the Hyperdrive binding, and the password never appears in
the Worker configuration.

## 5. Build the interface and deploy

```bash
pnpm run cf:deploy
```

That builds `web/dist` and runs `wrangler deploy`. The output ends with the
Worker URL, for example `https://errandly.<your-subdomain>.workers.dev`.

Check it:

```bash
curl https://errandly.<your-subdomain>.workers.dev/health
# {"ok":true}
```

Then open the URL: the React interface loads, `/docs` shows the OpenAPI
reference, and the demo accounts sign in as usual.

## 6. Local development against the Worker runtime

```bash
cp .dev.vars.example .dev.vars      # then edit JWT_SECRET and the Postgres URL
pnpm run cf:dev                     # http://localhost:8787
```

`wrangler dev` runs the real Workers runtime locally. Because a Hyperdrive
configuration only exists in production, Wrangler uses
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` from `.dev.vars` and
connects straight to Postgres. Use `pnpm run dev` + `pnpm run dev:web` for the
ordinary two-process Node development loop; `pnpm run cf:dev` is for checking
platform-specific behaviour.

## 7. Updating a deployment

```bash
pnpm run cf:deploy                       # new code/assets
npx wrangler secret put JWT_SECRET       # rotate a secret
pnpm run db migrate                      # new migration, with DATABASE_URL set
npx wrangler tail                        # live logs (console.log/console.error)
```

`schema_version` and migration bookkeeping are ordinary tables, so the Node CLI
and the Worker agree on state.

## Optional: custom domain

Dashboard → Workers & Pages → `errandly` → Settings → Domains & Routes → Add
custom domain. Cloudflare creates the DNS record and the certificate.

## How the Worker handles the database

Workers forbid reusing I/O objects (TCP sockets) between requests, so a
module-scoped `pg.Pool` would fail with "Cannot perform I/O on behalf of a
different request". `src/worker.ts` therefore:

1. creates a Knex instance for the request, with `pool.max = 1`;
2. binds it with `AsyncLocalStorage`, which `src/db.ts` exposes as the same `db`
   object the routes and services already import;
3. hands the request to Express;
4. destroys the instance when the response is complete, via `ctx.waitUntil`.

Hyperdrive keeps the real connection pool warm next to your database, so the
per-request connection is cheap. On Node the proxy falls back to one shared
instance, which is why the same code runs unchanged in Docker and in tests.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing required environment variable JWT_SECRET` | `npx wrangler secret put JWT_SECRET` (and restart `wrangler dev` after editing `.dev.vars`) |
| `The HYPERDRIVE binding is missing` | The `hyperdrive` entry in `wrangler.jsonc` is missing or the ID is still the placeholder; `wrangler deploy` must have succeeded |
| `connection attempt failed` / `ECONNREFUSED` | Database not reachable from Cloudflare, wrong port, or missing `?sslmode=require`. Hyperdrive cannot reach a database that only accepts private/VPN traffic |
| Neon: `connection attempt failed` on first request | Check the endpoint is the direct host (no `-pooler`) and that the Neon project is not suspended; the first request after a long idle period can be slower |
| Orders or cart look unchanged right after an action | The Hyperdrive config was created without `--caching-disabled`; reads are cached for up to 60 s. Fix with `npx wrangler hyperdrive update <ID> --caching-disabled` |
| `password authentication failed` | Credentials in the Hyperdrive connection string are wrong; recreate the config with a fresh string |
| `relation "users" does not exist` | Step 3 was skipped: run `pnpm run db migrate` against the same database |
| Login/register returns 500 with a CPU/timeout error in `wrangler tail` | Free plan CPU limit (10 ms) is too small for `bcrypt`; use the Workers Paid plan |
| `Could not resolve "mariadb/callback"` (or similar) on deploy | A new Knex version added a dialect; add it to `alias` in `wrangler.jsonc` pointing at `./src/cf/unavailable.ts` |
| Worker bundle too large | Run `pnpm run cf:dry-run`; the current bundle is ~700 KiB gzip against the 3 MiB free / 10 MiB paid limit |

## Limits worth knowing

- **Request body**: 100 MB on Workers, but the app's `express.json()` limit is
  100 KB (unchanged).
- **CPU time**: 10 ms free / 30 s paid per request. Password hashing dominates;
  the paid plan is effectively required for this app.
- **Subrequests/connections**: 6 simultaneous outgoing connections per
  invocation. The per-request pool is capped at 1, so the app stays well inside
  this.
- **No filesystem**: anything that reads files at runtime (migrations,
  `swagger-ui-express`, `express.static`) must run at build time or be served by
  Workers Assets, which is what `src/cf/app.ts` does.
