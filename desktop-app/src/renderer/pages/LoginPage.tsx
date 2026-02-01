import React, { useState } from 'react';
import { Shield, Loader2, AlertCircle } from 'lucide-react';
import { loginWithEmail } from '../services/auth-service';
import { logActivity } from '../services/firestore-service';

interface LoginPageProps {
  onLogin: () => void;
}

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const user = await loginWithEmail(email, password);
      await logActivity({
        userId: user.uid,
        userName: user.email,
        action: 'user_login',
        timestamp: new Date().toISOString(),
      });
      onLogin();
    } catch (err: any) {
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        setError('Invalid email or password');
      } else if (err.code === 'auth/too-many-requests') {
        setError('Too many attempts. Please try again later.');
      } else if (err.code === 'auth/network-request-failed') {
        setError('Network error. Check your internet connection.');
      } else {
        setError(err.message || 'Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
            style={{ background: 'linear-gradient(135deg, #6366f1, #7c3aed)', boxShadow: '0 8px 32px rgba(99, 102, 241, 0.3)' }}>
            <Shield size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Spectra</h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>Sign in to your account</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-xl p-6 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                placeholder="you@example.com"
                required
                autoFocus
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                placeholder="Enter your password"
                required
                disabled={loading}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
                <AlertCircle size={14} />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg text-[13px] font-semibold text-white transition-all flex items-center justify-center gap-2"
              style={{
                background: loading ? 'var(--text-muted)' : 'linear-gradient(135deg, #6366f1, #7c3aed)',
                boxShadow: loading ? 'none' : '0 4px 16px rgba(99, 102, 241, 0.3)',
              }}
            >
              {loading ? <><Loader2 size={16} className="animate-spin" /> Signing in...</> : 'Sign In'}
            </button>
          </div>

          <p className="text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Contact your administrator for account access
          </p>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
