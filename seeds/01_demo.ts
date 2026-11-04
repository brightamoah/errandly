import bcrypt from 'bcryptjs';
import { Knex } from 'knex';

/** Demo accounts for the shared test environment. Password for all: Demo1234! */
export const DEMO_PASSWORD = 'Demo1234!';

export async function seed(knex: Knex): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== 'true') {
    throw new Error('Refusing to seed in production. Set ALLOW_SEED=true for a demo environment.');
  }

  await knex.raw(
    'TRUNCATE order_events, issues, payments, purchase_lines, purchases, approvals, proposal_lines, proposals, order_items, orders, cart_items, users RESTART IDENTITY CASCADE',
  );

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = await knex('users')
    .insert([
      { email: 'admin@errandly.test', name: 'Ama Admin', role: 'admin', password_hash: hash },
      { email: 'customer@errandly.test', name: 'Kofi Customer', role: 'customer', password_hash: hash },
      { email: 'customer2@errandly.test', name: 'Esi Customer', role: 'customer', password_hash: hash },
      { email: 'shopper@errandly.test', name: 'Yaw Shopper', role: 'shopper', password_hash: hash },
      { email: 'shopper2@errandly.test', name: 'Abena Shopper', role: 'shopper', password_hash: hash },
    ])
    .returning(['id', 'email']);

  const customer = users.find((u) => u.email === 'customer@errandly.test')!;

  // A ready cart so the demo can start at "submit order".
  await knex('cart_items').insert([
    { customer_id: customer.id, name: 'Rice (5kg bag)', quantity: 1, notes: 'Jasmine if possible' },
    { customer_id: customer.id, name: 'Eggs (crate of 30)', quantity: 1 },
    { customer_id: customer.id, name: 'Tomato paste (400g tin)', quantity: 3 },
  ]);
}
