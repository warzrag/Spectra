import React, { useState } from 'react';
import { X, UserPlus, Mail, Shield, Eye, FolderOpen, Copy, Check } from 'lucide-react';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useToast } from '../contexts/ToastContext';
import { Folder, UserRole } from '../../types';

// Firebase config (same as main app)
const firebaseConfig = {
  apiKey: "AIzaSyBANJWl76DuMwb3ci2i_4WWrXniCbqowLs",
  authDomain: "spectra-59160.firebaseapp.com",
  projectId: "spectra-59160",
  storageBucket: "spectra-59160.firebasestorage.app",
  messagingSenderId: "583704444265",
  appId: "1:583704444265:web:75db7a2c41ed6b301391f8",
};

interface InviteMemberModalProps {
  onClose: () => void;
  onMemberAdded: () => void;
  teamId: string;
  folders: Folder[];
}

const InviteMemberModal: React.FC<InviteMemberModalProps> = ({ onClose, onMemberAdded, teamId, folders }) => {
  const { showToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('va');
  const [assignedFolderId, setAssignedFolderId] = useState<string>('');
  const [inviteLanguage, setInviteLanguage] = useState<'fr' | 'en'>('fr');
  const [loading, setLoading] = useState(false);
  const [inviteMessage, setInviteMessage] = useState('');
  const [copied, setCopied] = useState(false);

  const getAssignedFolderName = () => {
    if (role !== 'va') return 'Tous les dossiers';
    return folders.find(folder => folder.id === assignedFolderId)?.name || 'Dossier assigne';
  };

  const buildInviteMessage = () => {
    if (inviteLanguage === 'en') {
      return [
        'Hello,',
        '',
        'Your Spectra access is ready.',
        '',
        `Email: ${email}`,
        `Temporary password: ${password}`,
        `Role: ${role === 'admin' ? 'Admin' : 'Virtual Assistant'}`,
        `Authorized folder: ${getAssignedFolderName()}`,
        '',
        'Log in to Spectra with these credentials. You will also receive a Firebase email to set your own password.',
        '',
        'This account is personal. Do not share your credentials.',
      ].join('\n');
    }

    return [
      'Bonjour,',
      '',
      'Ton acces Spectra est pret.',
      '',
      `Email : ${email}`,
      `Mot de passe temporaire : ${password}`,
      `Role : ${role === 'admin' ? 'Admin' : 'Virtual Assistant'}`,
      `Dossier autorise : ${getAssignedFolderName()}`,
      '',
      'Connecte-toi a Spectra avec ces identifiants. Tu recevras aussi un email Firebase pour definir ton propre mot de passe.',
      '',
      'Ce compte est personnel. Ne partage pas tes identifiants.',
    ].join('\n');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    if (password.length < 6) {
      showToast('Password must be at least 6 characters', 'warning');
      return;
    }
    if (role === 'va' && !assignedFolderId) {
      showToast('Choose the folder this VA can access', 'warning');
      return;
    }

    setLoading(true);
    let secondaryApp = null;

    try {
      // Create a secondary Firebase app to avoid signing out the current user
      secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);

      // Create the user account
      const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);

      // Create Firestore user document (inherits teamId from inviter)
      await setDoc(doc(db, 'users', credential.user.uid), {
        uid: credential.user.uid,
        email: email,
        role: role,
        teamId: teamId,
        assignedFolderId: role === 'va' ? assignedFolderId : null,
        createdAt: new Date().toISOString(),
      });

      // Send password reset email so user can set their own password
      try {
        await sendPasswordResetEmail(secondaryAuth, email);
      } catch {
        // Not critical if this fails
      }

      // Sign out from secondary auth
      await secondaryAuth.signOut();

      showToast(`${email} invited as ${role === 'admin' ? 'Admin' : 'VA'}`, 'success');
      setInviteMessage(buildInviteMessage());
      onMemberAdded();
    } catch (error: any) {
      console.error('Failed to invite member:', error);
      if (error.code === 'auth/email-already-in-use') {
        showToast('This email is already registered', 'error');
      } else if (error.code === 'auth/invalid-email') {
        showToast('Invalid email address', 'error');
      } else {
        showToast(`Failed to invite member: ${error.message}`, 'error');
      }
    } finally {
      // Clean up secondary app
      if (secondaryApp) {
        try { await deleteApp(secondaryApp); } catch {}
      }
      setLoading(false);
    }
  };

  const copyInviteMessage = async () => {
    await navigator.clipboard.writeText(inviteMessage);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-xl w-full max-w-md overflow-hidden shadow-2xl non-draggable"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <UserPlus size={18} style={{ color: 'var(--accent)' }} />
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Invite Member</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Email */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Email Address
            </label>
            <div className="relative">
              <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                style={inputStyle}
                placeholder="user@example.com"
                required
                autoFocus
              />
            </div>
          </div>

          {/* Temporary Password */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Temporary Password
            </label>
            <input
              type="text"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
              style={inputStyle}
              placeholder="At least 6 characters"
              required
              minLength={6}
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              The member will receive a reset email to set their own password.
            </p>
          </div>

          {/* Role */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Role
            </label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setRole('va')}
                className="flex-1 px-4 py-3 rounded-lg text-left transition-all"
                style={{
                  background: role === 'va' ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-elevated)',
                  border: `1px solid ${role === 'va' ? 'var(--success)' : 'var(--border-default)'}`,
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Eye size={14} style={{ color: 'var(--success)' }} />
                  <span className="text-[13px] font-medium" style={{ color: role === 'va' ? 'var(--success)' : 'var(--text-primary)' }}>
                    Virtual Assistant
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Can use assigned profiles only
                </p>
              </button>
              <button
                type="button"
                onClick={() => setRole('admin')}
                className="flex-1 px-4 py-3 rounded-lg text-left transition-all"
                style={{
                  background: role === 'admin' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                  border: `1px solid ${role === 'admin' ? 'var(--accent)' : 'var(--border-default)'}`,
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Shield size={14} style={{ color: 'var(--accent-light)' }} />
                  <span className="text-[13px] font-medium" style={{ color: role === 'admin' ? 'var(--accent-light)' : 'var(--text-primary)' }}>
                    Admin
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Full access to all features
                </p>
              </button>
            </div>
          </div>

          {/* Invite language */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Invite Message Language
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setInviteLanguage('fr')}
                className="px-3 py-2 rounded-lg text-[13px] font-medium transition-all"
                style={{
                  background: inviteLanguage === 'fr' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                  border: `1px solid ${inviteLanguage === 'fr' ? 'var(--accent)' : 'var(--border-default)'}`,
                  color: inviteLanguage === 'fr' ? 'var(--accent-light)' : 'var(--text-secondary)',
                }}
              >
                FR
              </button>
              <button
                type="button"
                onClick={() => setInviteLanguage('en')}
                className="px-3 py-2 rounded-lg text-[13px] font-medium transition-all"
                style={{
                  background: inviteLanguage === 'en' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                  border: `1px solid ${inviteLanguage === 'en' ? 'var(--accent)' : 'var(--border-default)'}`,
                  color: inviteLanguage === 'en' ? 'var(--accent-light)' : 'var(--text-secondary)',
                }}
              >
                EN / US
              </button>
            </div>
          </div>

          {/* Folder access */}
          {role === 'va' && (
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                VA Folder Access
              </label>
              <div className="relative">
                <FolderOpen size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <select
                  value={assignedFolderId}
                  onChange={e => setAssignedFolderId(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  style={inputStyle}
                  required
                >
                  <option value="">Choose a folder</option>
                  {folders.map(folder => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                This VA will only see instances inside this folder.
              </p>
            </div>
          )}

          {inviteMessage && (
            <div className="rounded-lg p-3 space-y-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
              <div>
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Invite message ready
                </div>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Copy this message and send it to the VA by Gmail, WhatsApp, or Telegram.
                </p>
              </div>
              <textarea
                value={inviteMessage}
                readOnly
                rows={8}
                className="w-full px-3 py-2 rounded-lg text-[12px] resize-none"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
              <button
                type="button"
                onClick={copyInviteMessage}
                className="w-full px-3 py-2 rounded-lg text-[12px] font-medium flex items-center justify-center gap-2"
                style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy invite message'}
              </button>
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-end gap-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
            style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={Boolean(inviteMessage) || loading || !email.trim() || !password.trim() || (role === 'va' && !assignedFolderId)}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-all flex items-center gap-2"
            style={{
              background: loading ? 'var(--text-muted)' : 'linear-gradient(135deg, #6366f1, #7c3aed)',
              opacity: (inviteMessage || !email.trim() || !password.trim()) ? 0.5 : 1,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <UserPlus size={14} />
                Invite
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default InviteMemberModal;
