/**
 * Stub for database drivers Knex can target but Errandly never uses.
 * Knex `require()`s every dialect lazily; the Workers bundler needs each
 * specifier to resolve, so wrangler.jsonc aliases them here.
 */
export default function unavailable(): never {
  throw new Error('This database driver is not available in the Cloudflare Workers build');
}
