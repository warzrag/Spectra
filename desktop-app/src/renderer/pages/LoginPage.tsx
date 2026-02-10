import React, { useState } from 'react';
import { Shield, Loader2, AlertCircle } from 'lucide-react';
import { loginWithEmail, registerWithInviteCode } from '../services/auth-service';
import { logActivity } from '../services/firestore-service';

interface LoginPageProps {
  onLogin: () => void;
}

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
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
        setError('Email ou mot de passe incorrect');
      } else if (err.code === 'auth/too-many-requests') {
        setError('Trop de tentatives. Réessayez plus tard.');
      } else if (err.code === 'auth/network-request-failed') {
        setError('Erreur réseau. Vérifiez votre connexion.');
      } else {
        setError(err.message || 'Échec de connexion');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas');
      return;
    }
    if (password.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères');
      return;
    }
    if (!inviteCode.trim()) {
      setError('Code d\'invitation requis');
      return;
    }

    setLoading(true);
    try {
      const user = await registerWithInviteCode(email, password, inviteCode.trim());
      await logActivity({
        userId: user.uid,
        userName: user.email,
        action: 'user_login',
        timestamp: new Date().toISOString(),
      });
      onLogin();
    } catch (err: any) {
      if (err.code === 'auth/email-already-in-use') {
        setError('Cet email est déjà utilisé');
      } else if (err.code === 'auth/invalid-email') {
        setError('Email invalide');
      } else if (err.code === 'auth/weak-password') {
        setError('Mot de passe trop faible (min. 6 caractères)');
      } else {
        setError(err.message || 'Échec de l\'inscription');
      }
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setError('');
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
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>
            {mode === 'login' ? 'Connectez-vous à votre compte' : 'Créer un nouveau compte'}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={mode === 'login' ? handleLogin : handleRegister} className="space-y-4">
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
              <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Mot de passe
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                placeholder={mode === 'login' ? 'Votre mot de passe' : 'Min. 6 caractères'}
                required
                disabled={loading}
              />
            </div>

            {mode === 'register' && (
              <>
                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Confirmer le mot de passe
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    placeholder="Répétez le mot de passe"
                    required
                    disabled={loading}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Code d'invitation
                  </label>
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={e => setInviteCode(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                    placeholder="XXXX-XXXX"
                    required
                    disabled={loading}
                  />
                </div>
              </>
            )}

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
              {loading
                ? <><Loader2 size={16} className="animate-spin" /> {mode === 'login' ? 'Connexion...' : 'Création...'}</>
                : mode === 'login' ? 'Se connecter' : 'Créer mon compte'
              }
            </button>
          </div>

          <p className="text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {mode === 'login' ? (
              <>Pas encore de compte ? <button type="button" onClick={switchMode} className="font-semibold hover:underline" style={{ color: 'var(--accent-light)' }}>Créer un compte</button></>
            ) : (
              <>Déjà un compte ? <button type="button" onClick={switchMode} className="font-semibold hover:underline" style={{ color: 'var(--accent-light)' }}>Se connecter</button></>
            )}
          </p>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
