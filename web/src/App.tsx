import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import AdminIssues from './pages/AdminIssues';
import Available from './pages/Available';
import Cart from './pages/Cart';
import Login from './pages/Login';
import OrderDetail from './pages/OrderDetail';
import Orders from './pages/Orders';

const NAV = {
  customer: [['/cart', 'Shopping list'], ['/orders', 'My orders']],
  shopper: [['/available', 'Open requests'], ['/orders', 'My jobs']],
  admin: [['/issues', 'Issues'], ['/orders', 'All orders']],
} as const;

const HOME = { customer: '/cart', shopper: '/available', admin: '/issues' };

export default function App() {
  const { user, ready, signOut } = useAuth();
  if (!ready) return null;
  if (!user) return <Login />;

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to={HOME[user.role]} className="brand" aria-label="Errandly home">
          <img src="/favicon.svg" alt="" width={28} height={28} /> Errandly
        </NavLink>
        <nav>
          {NAV[user.role].map(([to, label]) => (
            <NavLink key={to} to={to}>{label}</NavLink>
          ))}
        </nav>
        <div className="who">
          <span>{user.name}<small>{user.role}</small></span>
          <button className="ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main>
        <Routes>
          {user.role === 'customer' && <Route path="/cart" element={<Cart />} />}
          {user.role === 'shopper' && <Route path="/available" element={<Available />} />}
          {user.role === 'admin' && <Route path="/issues" element={<AdminIssues />} />}
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="*" element={<Navigate to={HOME[user.role]} replace />} />
        </Routes>
      </main>
    </div>
  );
}
