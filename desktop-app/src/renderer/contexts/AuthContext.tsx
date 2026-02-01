import React, { createContext, useContext } from 'react';
import { AppUser } from '../../types';

interface AuthContextValue {
  user: AppUser | null;
  isAdmin: boolean;
  isVA: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

interface AuthProviderProps {
  user: AppUser | null;
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ user, children }) => {
  const value: AuthContextValue = {
    user,
    isAdmin: user?.role === 'admin',
    isVA: user?.role === 'va',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export default AuthContext;
