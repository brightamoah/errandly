import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { api, setCurrency, tokenStore, User } from './api';

interface AuthState {
  user: User | null;
  ready: boolean;
  signIn: (token: string, user: User) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api('/config').then((c) => setCurrency(c.currency)).catch(() => {});
    if (!tokenStore.get()) { setReady(true); return; }
    api('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => tokenStore.set(null))
      .finally(() => setReady(true));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        ready,
        signIn: (token, u) => { tokenStore.set(token); setUser(u); },
        signOut: () => { tokenStore.set(null); setUser(null); },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
