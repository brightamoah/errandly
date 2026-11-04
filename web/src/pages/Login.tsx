import { FormEvent, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorNote, useAction } from '../ui';

const DEMO = [
  ['customer@errandly.test', 'Customer'],
  ['shopper@errandly.test', 'Shopper'],
  ['admin@errandly.test', 'Admin'],
];

export default function Login() {
  const { signIn } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'customer' });
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = mode === 'login'
        ? await api('/auth/login', { body: { email: form.email, password: form.password } })
        : await api('/auth/register', { body: form });
      signIn(r.token, r.user);
    });
  };

  const demo = (email: string) => run(async () => {
    const r = await api('/auth/login', { body: { email, password: 'Demo1234!' } });
    signIn(r.token, r.user);
  });

  return (
    <div className="login">
      <section className="login-intro">
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>Send someone to the market for you.</h1>
        <p>Write your list and set a budget. A shopper buys it, checks any swaps with you first, and brings it to your door with the receipt.</p>
      </section>

      <form className="card login-form" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
        {mode === 'register' && (
          <>
            <label>Your name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <fieldset className="segmented">
              <legend>I want to</legend>
              {[['customer', 'Order shopping'], ['shopper', 'Shop for others']].map(([v, l]) => (
                <label key={v} className={form.role === v ? 'on' : ''}>
                  <input type="radio" name="role" value={v} checked={form.role === v} onChange={() => setForm({ ...form, role: v })} />{l}
                </label>
              ))}
            </fieldset>
          </>
        )}
        <label>Email<input type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Password<input type="password" required minLength={mode === 'register' ? 8 : undefined} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <ErrorNote error={error} />
        <button className="primary" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>

        <div className="demo">
          <p>Try a demo account</p>
          <div>{DEMO.map(([email, label]) => <button type="button" key={email} className="ghost" disabled={busy} onClick={() => demo(email)}>{label}</button>)}</div>
        </div>
      </form>
    </div>
  );
}
