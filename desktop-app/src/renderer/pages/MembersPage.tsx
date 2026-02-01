import React, { useState, useEffect } from 'react';
import { UsersRound, UserPlus, Shield, Eye, MoreVertical, Mail, Calendar, Trash2, Crown } from 'lucide-react';
import { collection, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore';
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

const MembersPage: React.FC = () => {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);

  useEffect(() => {
    loadMembers();
  }, []);

  const loadMembers = async () => {
    try {
      const snapshot = await getDocs(collection(db, 'users'));
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
          <div className="rounded-xl overflow-hidden overflow-x-auto" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
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
                        <div className="absolute right-0 top-full mt-1 rounded-lg shadow-xl z-10 overflow-hidden py-1 min-w-[160px]"
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
      </div>

      {showInviteModal && (
        <InviteMemberModal
          onClose={() => setShowInviteModal(false)}
          onMemberAdded={loadMembers}
        />
      )}
    </div>
  );
};

export default MembersPage;
