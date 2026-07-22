'use client';

import { createContext, useContext, useMemo, ReactNode } from 'react';
import { User } from '@supabase/supabase-js';

interface AuthContextType {
  token: string | null;
  user: User | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Sign-in removed in this (Flutter-embed) fork: there is no Supabase session,
// no auth network traffic, and the user is always logged out. The context stays
// so the many `useAuth()` consumers keep working — they simply always see
// `user: null` (cloud sync / account features stay disabled), and login/logout/
// refresh are inert no-ops.
export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const value = useMemo<AuthContextType>(
    () => ({
      token: null,
      user: null,
      login: () => {},
      logout: () => {},
      refresh: () => {},
    }),
    [],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
