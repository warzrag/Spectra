import React, { useState, useEffect } from 'react';
import { UsersRound, UserPlus, Shield, Eye, MoreVertical, Mail, Calendar, Trash2, Crown, Ticket, Copy, Check, Plus, Loader2 } from 'lucide-react';
import { collection, getDocs, query, where, doc, updateDoc, deleteDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import InviteMemberModal from '../components/InviteMemberModal';
import { UserRole } from '../../types';

interface Member {
  uid: string;
  email: string;
  role: UserRole;
  displayName?: string;
  createdAt?: string;
}

interface InviteCode {
  id: string;
  used: boolean;
  codeType?: 'team' | 'personal';
  createdBy: string;
  createdAt: string;
  usedBy?: string;
  usedByEmail?: string;
  usedAt?: string;
}

interface MembersPageProps {
  teamId: string;
}

const MembersPage: React.FC<MembersPageProps> = ({ teamId }) => {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);

  useEffect(() => {
    loadMembers();
  }, []);

  // Subscribe to invite codes (real-time)
  useEffect(() => {
    if (!user?.uid) return;
    const q = query(collection(db, 'inviteCodes'), where('createdBy', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const codes: InviteCode[] = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data(),
      })) as InviteCode[];
      codes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setInviteCodes(codes);
    });
    return () => unsub();
  }, [user?.uid]);

  const loadMembers = async () => {
    try {
      const q = query(collection(db, 'users'), where('teamId', '==', teamId));
      const snapshot = await getDocs(q);
      const membersList: Member[] = [];
      snapshot.forEach((doc) => {
        membersList.push({ uid: doc.id, ...doc.data() } as Member);
      });
      setMembers(membersList);
    } catch (e) {
      console.error('Error loading members:', e);
    } finally {
      setLoading(false);
    }
  };

  const currentUserRole = members.find(m => m.uid === user?.uid)?.role;

  const handleRoleChange = async (memberId: string, newRole: UserRole) => {
    const target = members.find(m => m.uid === memberId);
    if (target?.role === 'owner') {
      showToast('Cannot change the Owner role', 'error');
      return;
    }
    if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
      showToast('Only Owner and Admins can change roles', 'error');
      return;
    }
    try {
      await updateDoc(doc(db, 'users', memberId), { role: newRole });
      setMembers(prev => prev.map(m => m.uid === memberId ? { ...m, role: newRole } : m));
      setMenuOpenId(null);
      showToast(`${target?.email || 'Member'} is now ${newRole === 'admin' ? 'Admin' : 'VA'}`, 'success');
    } catch (e) {
      console.error('Error updating role:', e);
      showToast('Failed to update role', 'error');
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    const target = members.find(m => m.uid === memberId);
    if (target?.role === 'owner') {
      showToast('Cannot remove the Owner', 'error');
      return;
    }
    if (currentUserRole !== 'owner' && currentUserRole !== 'admin') {
      showToast('Only Owner and Admins can remove members', 'error');
      return;
    }
    if (!window.confirm('Remove this member? They will lose access.')) return;
    try {
      await deleteDoc(doc(db, 'users', memberId));
      setMembers(prev => prev.filter(m => m.uid !== memberId));
      setMenuOpenId(null);
      showToast(`${target?.email || 'Member'} removed`, 'success');
    } catch (e) {
      console.error('Error removing member:', e);
      showToast('Failed to remove member', 'error');
    }
  };

  const generateInviteCode = async (type: 'team' | 'personal') => {
    if (!user) return;
    setGeneratingCode(true);
    try {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = 'SPECTRA-';
      for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));

      const data: any = {
        used: false,
        codeType: type,
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      };
      if (type === 'team') {
        data.teamId = teamId;
      }

      await setDoc(doc(db, 'inviteCodes', code), data);
      showToast(`Code ${code} created (${type === 'team' ? 'Team' : 'Personal'})`, 'success');
    } catch (e) {
      console.error('Error generating invite code:', e);
      showToast('Failed to generate code', 'error');
    } finally {
      setGeneratingCode(false);
    }
  };

  const deleteInviteCode = async (codeId: string) => {
    try {
      await deleteDoc(doc(db, 'inviteCodes', codeId));
      showToast('Code deleted', 'success');
    } catch (e) {
      console.error('Error deleting invite code:', e);
      showToast('Failed to delete code', 'error');
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCodeId(code);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return '-';
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl xl:max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Members</h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>Manage your team members and roles</p>
          </div>
          <button
            onClick={() => setShowInviteModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-all"
            style={{ background: 'linear-gradient(135deg, #6366f1, #7c3aed)', boxShadow: '0 2px 8px rgba(99, 102, 241, 0.25)' }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(99, 102, 241, 0.35)'}
            onMouseLeave={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(99, 102, 241, 0.25)'}
          >
            <UserPlus size={16} />
            Invite Member
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div className="flex items-center gap-2 mb-1">
              <UsersRound size={16} style={{ color: 'var(--accent)' }} />
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Total Members</span>
            </div>
            <div className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{members.length}</div>
          </div>
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Shield size={16} style={{ color: '#f59e0b' }} />
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Admins</span>
            </div>
            <div className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{members.filter(m => m.role === 'admin').length}</div>
          </div>
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div className="flex items-center gap-2 mb-1">
              <Eye size={16} style={{ color: 'var(--success)' }} />
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Virtual Assistants</span>
            </div>
            <div className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{members.filter(m => m.role === 'va').length}</div>
          </div>
        </div>

        {/* Members Table */}
        <section>
          <div className="rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', overflow: 'visible' }}>
            {/* Table Header */}
            <div className="grid grid-cols-[1fr_120px_120px_60px] min-w-[480px] px-5 py-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
              <span>Member</span>
              <span>Role</span>
              <span>Joined</span>
              <span></span>
            </div>

            {/* Loading */}
            {loading && (
              <div className="px-5 py-8 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading members...</div>
            )}

            {/* Members */}
            {!loading && members.map((member) => (
              <div
                key={member.uid}
                className="grid grid-cols-[1fr_120px_120px_60px] min-w-[480px] px-5 py-3 items-center transition-colors"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {/* Email + avatar */}
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0"
                    style={{ background: member.role === 'admin' ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : 'linear-gradient(135deg, #059669, #10b981)' }}>
                    {member.email?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div>
                    <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {member.displayName || member.email}
                    </div>
                    {member.displayName && (
                      <div className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                        <Mail size={10} /> {member.email}
                      </div>
                    )}
                    {member.uid === user?.uid && (
                      <span className="text-[10px] font-medium" style={{ color: 'var(--accent-light)' }}>You</span>
                    )}
                  </div>
                </div>

                {/* Role badge */}
                <div>
                  <span className="text-[11px] px-2.5 py-1 rounded-full font-semibold uppercase"
                    style={{
                      background: member.role === 'owner' ? 'rgba(245, 158, 11, 0.1)' : member.role === 'admin' ? 'var(--accent-subtle)' : 'rgba(16, 185, 129, 0.1)',
                      color: member.role === 'owner' ? '#f59e0b' : member.role === 'admin' ? 'var(--accent-light)' : 'var(--success)',
                    }}>
                    {member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'VA'}
                  </span>
                </div>

                {/* Date */}
                <div className="text-[12px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                  <Calendar size={12} />
                  {formatDate(member.createdAt)}
                </div>

                {/* Actions */}
                <div className="relative">
                  {member.uid !== user?.uid && member.role !== 'owner' && (
                    <>
                      <button
                        onClick={() => setMenuOpenId(menuOpenId === member.uid ? null : member.uid)}
                        className="p-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--text-muted)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <MoreVertical size={16} />
                      </button>

                      {menuOpenId === member.uid && (
                        <div className="absolute right-0 top-full mt-1 rounded-lg shadow-xl z-50 overflow-hidden py-1 min-w-[160px]"
                          style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}>
                          <button
                            onClick={() => handleRoleChange(member.uid, member.role === 'admin' ? 'va' : 'admin')}
                            className="w-full px-3 py-2 text-[13px] text-left flex items-center gap-2 transition-colors"
                            style={{ color: 'var(--text-secondary)' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                          >
                            <Shield size={14} />
                            {member.role === 'admin' ? 'Demote to VA' : 'Promote to Admin'}
                          </button>
                          <button
                            onClick={() => handleRemoveMember(member.uid)}
                            className="w-full px-3 py-2 text-[13px] text-left flex items-center gap-2 transition-colors"
                            style={{ color: 'var(--danger)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <Trash2 size={14} />
                            Remove Member
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}

            {!loading && members.length === 0 && (
              <div className="px-5 py-8 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>No members found</div>
            )}
          </div>
        </section>

        {/* Invite Codes Section — Owner only */}
        {user?.role === 'owner' && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Invite Codes</h2>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Generate codes to let new users sign up on the website</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => generateInviteCode('team')}
                disabled={generatingCode}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium text-white transition-all disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #6366f1, #7c3aed)' }}
                title="The user joins your team as VA"
              >
                {generatingCode ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Code Team
              </button>
              <button
                onClick={() => generateInviteCode('personal')}
                disabled={generatingCode}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition-all disabled:opacity-50"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                title="The user gets their own independent workspace"
              >
                {generatingCode ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Code Perso
              </button>
            </div>
          </div>

          <div className="rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            {/* Header */}
            <div className="grid grid-cols-[1fr_80px_100px_140px_80px] px-5 py-3 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
              <span>Code</span>
              <span>Type</span>
              <span>Status</span>
              <span>Used by</span>
              <span></span>
            </div>

            {inviteCodes.length === 0 && (
              <div className="px-5 py-6 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                No invite codes yet. Click "Generate Code" to create one.
              </div>
            )}

            {inviteCodes.map((code) => (
              <div
                key={code.id}
                className="grid grid-cols-[1fr_80px_100px_140px_80px] px-5 py-3 items-center transition-colors"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {/* Code + copy */}
                <div className="flex items-center gap-2">
                  <Ticket size={14} style={{ color: code.used ? 'var(--text-muted)' : 'var(--accent)' }} />
                  <span className="text-[13px] font-mono tracking-wide" style={{ color: code.used ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                    {code.id}
                  </span>
                  {!code.used && (
                    <button
                      onClick={() => copyCode(code.id)}
                      className="p-1 rounded transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                      title="Copy code"
                    >
                      {copiedCodeId === code.id ? <Check size={13} style={{ color: 'var(--success)' }} /> : <Copy size={13} />}
                    </button>
                  )}
                </div>

                {/* Type */}
                <div>
                  <span className="text-[11px] px-2 py-1 rounded-full font-medium"
                    style={{
                      background: code.codeType === 'personal' ? 'rgba(245, 158, 11, 0.1)' : 'var(--accent-subtle)',
                      color: code.codeType === 'personal' ? '#f59e0b' : 'var(--accent-light)',
                    }}>
                    {code.codeType === 'personal' ? 'Perso' : 'Team'}
                  </span>
                </div>

                {/* Status */}
                <div>
                  <span className="text-[11px] px-2.5 py-1 rounded-full font-semibold uppercase"
                    style={{
                      background: code.used ? 'rgba(239, 68, 68, 0.08)' : 'rgba(16, 185, 129, 0.1)',
                      color: code.used ? 'var(--danger)' : 'var(--success)',
                    }}>
                    {code.used ? 'Used' : 'Active'}
                  </span>
                </div>

                {/* Used by */}
                <div className="text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {code.usedByEmail || '-'}
                </div>

                {/* Delete */}
                <div className="flex justify-end">
                  <button
                    onClick={() => deleteInviteCode(code.id)}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.background = 'var(--danger-subtle)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                    title="Delete code"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
        )}
      </div>

      {showInviteModal && (
        <InviteMemberModal
          onClose={() => setShowInviteModal(false)}
          onMemberAdded={loadMembers}
          teamId={teamId}
        />
      )}
    </div>
  );
};

export default MembersPage;
