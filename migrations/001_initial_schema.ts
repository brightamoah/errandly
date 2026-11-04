import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('email').notNullable().unique();
    t.string('password_hash').notNullable();
    t.string('name').notNullable();
    t.enu('role', ['customer', 'shopper', 'admin'], { useNative: true, enumName: 'user_role' }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('cart_items', (t) => {
    t.increments('id').primary();
    t.integer('customer_id').notNullable().references('users.id').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.integer('quantity').notNullable();
    t.string('notes', 500);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['customer_id']);
  });
  await knex.raw('ALTER TABLE cart_items ADD CONSTRAINT cart_qty_positive CHECK (quantity > 0)');

  await knex.schema.createTable('orders', (t) => {
    t.increments('id').primary();
    t.integer('customer_id').notNullable().references('users.id');
    t.integer('shopper_id').references('users.id');
    t.string('status', 32).notNullable();
    t.integer('budget_minor').notNullable(); // max spend on goods
    t.integer('fee_minor').notNullable(); // stored at submission, never recalculated
    t.string('currency', 3).notNullable();
    t.string('delivery_address', 500).notNullable();
    t.string('notes', 1000);
    t.string('idempotency_key', 100).notNullable();
    t.integer('current_proposal_id'); // FK added after proposals table
    t.integer('goods_total_minor'); // set from purchase record, server-calculated
    t.integer('final_total_minor'); // goods + fee
    t.boolean('has_open_issue').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['customer_id', 'idempotency_key']);
    t.index(['status']);
    t.index(['shopper_id']);
  });
  await knex.raw('ALTER TABLE orders ADD CONSTRAINT orders_budget_positive CHECK (budget_minor > 0)');
  await knex.raw('ALTER TABLE orders ADD CONSTRAINT orders_fee_nonneg CHECK (fee_minor >= 0)');

  await knex.schema.createTable('order_items', (t) => {
    t.increments('id').primary();
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.string('name', 200).notNullable();
    t.integer('quantity').notNullable();
    t.string('notes', 500);
    t.index(['order_id']);
  });

  await knex.schema.createTable('proposals', (t) => {
    t.increments('id').primary();
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('status', 16).notNullable(); // PENDING | APPROVED | REJECTED | SUPERSEDED
    t.integer('goods_total_minor').notNullable();
    t.integer('fee_minor').notNullable();
    t.integer('total_minor').notNullable();
    t.boolean('requires_customer_approval').notNullable();
    t.string('rejection_reason', 500);
    t.integer('created_by').notNullable().references('users.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['order_id', 'version']);
  });
  await knex.raw(
    'ALTER TABLE orders ADD CONSTRAINT orders_current_proposal_fk FOREIGN KEY (current_proposal_id) REFERENCES proposals(id)',
  );

  await knex.schema.createTable('proposal_lines', (t) => {
    t.increments('id').primary();
    t.integer('proposal_id').notNullable().references('proposals.id').onDelete('CASCADE');
    t.integer('order_item_id').notNullable().references('order_items.id');
    t.string('kind', 16).notNullable(); // AS_REQUESTED | SUBSTITUTE | UNAVAILABLE
    t.string('name', 200).notNullable();
    t.integer('quantity').notNullable();
    t.integer('unit_price_minor').notNullable();
    t.string('note', 500);
  });

  // An approval authorises exactly one proposal version for a fixed amount.
  await knex.schema.createTable('approvals', (t) => {
    t.increments('id').primary();
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.integer('proposal_id').notNullable().references('proposals.id').unique();
    t.integer('approved_amount_minor').notNullable();
    t.string('method', 16).notNullable(); // CUSTOMER | AUTO
    t.integer('approved_by').references('users.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('purchases', (t) => {
    t.increments('id').primary();
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE').unique();
    t.integer('proposal_id').notNullable().references('proposals.id');
    t.integer('approval_id').notNullable().references('approvals.id');
    t.string('store_name', 200).notNullable();
    t.string('receipt_number', 100).notNullable();
    t.string('receipt_note', 1000);
    t.integer('goods_total_minor').notNullable();
    t.integer('fee_minor').notNullable();
    t.integer('final_total_minor').notNullable();
    t.integer('recorded_by').notNullable().references('users.id');
    t.timestamp('purchased_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('purchase_lines', (t) => {
    t.increments('id').primary();
    t.integer('purchase_id').notNullable().references('purchases.id').onDelete('CASCADE');
    t.integer('proposal_line_id').notNullable().references('proposal_lines.id');
    t.string('name', 200).notNullable();
    t.integer('quantity').notNullable();
    t.integer('unit_price_minor').notNullable();
    t.integer('line_total_minor').notNullable();
  });

  await knex.schema.createTable('payments', (t) => {
    t.increments('id').primary();
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.integer('amount_minor').notNullable();
    t.string('currency', 3).notNullable();
    t.string('status', 16).notNullable(); // SUCCEEDED | FAILED
    t.string('failure_reason', 200);
    t.string('idempotency_key', 100).notNullable();
    t.string('simulated_reference', 64).notNullable();
    t.integer('initiated_by').notNullable().references('users.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['order_id', 'idempotency_key']);
  });
  // The database itself guarantees at most one successful payment per order.
  await knex.raw(
    "CREATE UNIQUE INDEX payments_one_success_per_order ON payments(order_id) WHERE status = 'SUCCEEDED'",
  );

  await knex.schema.createTable('issues', (t) => {
    t.increments('id').primary();
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.integer('reported_by').notNullable().references('users.id');
    t.text('description').notNullable();
    t.string('status', 16).notNullable(); // OPEN | RESOLVED
    t.text('resolution_notes');
    t.integer('resolved_by').references('users.id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('resolved_at', { useTz: true });
  });

  await knex.schema.createTable('order_events', (t) => {
    t.increments('id').primary();
    t.integer('order_id').notNullable().references('orders.id').onDelete('CASCADE');
    t.string('type', 40).notNullable();
    t.string('from_status', 32);
    t.string('to_status', 32);
    t.integer('actor_id').references('users.id'); // null = system
    t.string('actor_role', 16).notNullable();
    t.string('note', 1000);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['order_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'order_events',
    'issues',
    'payments',
    'purchase_lines',
    'purchases',
    'approvals',
    'proposal_lines',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw('ALTER TABLE IF EXISTS orders DROP CONSTRAINT IF EXISTS orders_current_proposal_fk');
  for (const table of ['proposals', 'order_items', 'orders', 'cart_items', 'users']) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw('DROP TYPE IF EXISTS user_role');
}
