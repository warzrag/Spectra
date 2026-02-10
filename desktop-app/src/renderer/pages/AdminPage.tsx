import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Crown, Users, UsersRound, Ticket, Trash2, Shield, Eye, Calendar, MoreVertical, Loader2, Monitor, RefreshCw } from 'lucide-react';
import { collection, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useToast } from '../contexts/ToastContext';
import { UserRole } from '../../types';

const SUPER_ADMIN_UID = 'EsZbVc0qtNYwTsUmXm9drmF5hu53';

interface AdminUser {
  uid: string;
  email: string;
  role: UserRole;
  teamId?: string;
  createdAt?: string;
}

interface AdminTeam {
  id: string;
  name: string;
  ownerId: string;
}

interface AdminProfile {
  id: string;
  teamId?: string;
  createdBy?: string;
  deleted?: boolean;
}

interface AdminInviteCode {
  id: string;
  used: boolean;
  codeType?: 'team' | 'personal';
  createdBy: string;
  createdAt: string;
  usedByEmail?: string;
}

const AdminPage: React.FC = () => {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [profiles, setProfiles] = useState<AdminProfile[]>([]);
  const [inviteCodes, setInviteCodes] = useState<AdminInviteCode[]>([]);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [usersSnap, teamsSnap, profilesSnap, codesSnap] = await Promise.all([
        getDocs(collection(db, 'users')),
        getDocs(collection(db, 'teams')),
        getDocs(collection(db, 'profiles')),
        getDocs(collection(db, 'inviteCodes')),
      ]);

      const usersList: AdminUser[] = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() } as AdminUser));
      setUsers(usersList);
      setTeams(teamsSnap.docs.map(d => ({ id: d.id, ...d.data() } as AdminTeam)));
      setProfiles(profilesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AdminProfile)));

      const codes: AdminInviteCode[] = codesSnap.docs.map(d => ({ id: d.id, ...d.data() } as AdminInviteCode));
      codes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setInviteCodes(codes);
    } catch (e) {
      console.error('Admin: Error loading data:', e);
      showToast('Erreur chargement données', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    try {
      await updateDoc(doc(db, 'users', userId), { role: newRole });
      setUsers(prev => prev.map(u => u.uid === userId ? { ...u, role: newRole } : u));
      setMenuOpenId(null);
      showToast(`Rôle → ${newRole}`, 'success');
    } catch { showToast('Erreur', 'error'); }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!window.confirm('Supprimer cet utilisateur ?')) return;
    try {
      await deleteDoc(doc(db, 'users', userId));
      setUsers(prev => prev.filter(u => u.uid !== userId));
      setMenuOpenId(null);
      showToast('Supprimé', 'success');
    } catch { showToast('Erreur', 'error'); }
  };

  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const openMenuAt = (uid: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ top: rect.top, left: rect.right - 220 });
    setMenuOpenId(menuOpenId === uid ? null : uid);
  };

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const handleClick = () => { setMenuOpenId(null); setMenuPos(null); };
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handleClick); };
  }, [menuOpenId]);

  const handleAssignTeam = async (userId: string, teamId: string) => {
    try {
      await updateDoc(doc(db, 'users', userId), { teamId });
      setUsers(prev => prev.map(u => u.uid === userId ? { ...u, teamId } : u));
      setMenuOpenId(null);
      const teamName = teams.find(t => t.id === teamId)?.name || teamId;
      showToast(`Ajouté à ${teamName}`, 'success');
    } catch { showToast('Erreur', 'error'); }
  };

  const handleDeleteEmptyTeams = async (ownerId: string, keepTeamId: string) => {
    const toDelete = teams.filter(t => t.ownerId === ownerId && t.id !== keepTeamId);
    if (toDelete.length === 0) return;
    if (!window.confirm(`Supprimer ${toDelete.length} team(s) vide(s) en doublon ?`)) return;
    try {
      for (const t of toDelete) {
        await deleteDoc(doc(db, 'teams', t.id));
      }
      showToast(`${toDelete.length} team(s) supprimée(s)`, 'success');
      await loadAll(); // Recharge tout depuis Firestore
    } catch { showToast('Erreur suppression', 'error'); }
  };

  const handleDeleteTeam = async (teamId: string, ownerId: string) => {
    const teamMembers = users.filter(u => u.teamId === teamId);
    const msg = teamMembers.length > 0
      ? `Supprimer cette team ? (${teamMembers.length} membre(s) seront sans team)`
      : 'Supprimer cette team vide ?';
    if (!window.confirm(msg)) return;
    try {
      // Delete all team docs for this owner
      const ownerTeams = teams.filter(t => t.ownerId === ownerId);
      for (const t of ownerTeams) {
        await deleteDoc(doc(db, 'teams', t.id));
      }
      // Remove teamId from members so they become orphans
      for (const m of teamMembers) {
        await updateDoc(doc(db, 'users', m.uid), { teamId: '' });
      }
      showToast('Team supprimée', 'success');
      await loadAll();
    } catch { showToast('Erreur suppression team', 'error'); }
  };

  const handleDeleteCode = async (codeId: string) => {
    try {
      await deleteDoc(doc(db, 'inviteCodes', codeId));
      setInviteCodes(prev => prev.filter(c => c.id !== codeId));
      showToast('Code supprimé', 'success');
    } catch { showToast('Erreur', 'error'); }
  };

  const formatDate = (d?: string) => {
    if (!d) return '-';
    try { return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch { return '-'; }
  };

  const activeProfiles = profiles.filter(p => !p.deleted).length;

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  // Group teams by ownerId — merge duplicates into one card
  const ownerTeamsMap = new Map<string, typeof teams>();
  for (const team of teams) {
    const list = ownerTeamsMap.get(team.ownerId) || [];
    list.push(team);
    ownerTeamsMap.set(team.ownerId, list);
  }

  const teamData = Array.from(ownerTeamsMap.values()).map(ownerTeams => {
    const allTeamIds = new Set(ownerTeams.map(t => t.id));
    const owner = users.find(u => u.uid === ownerTeams[0].ownerId);
    // Members = users whose teamId matches any of the owner's teams
    const members = users.filter(u => u.teamId && allTeamIds.has(u.teamId));
    const instanceCount = profiles.filter(p => p.teamId && allTeamIds.has(p.teamId) && !p.deleted).length;
    // Use the team that has the most activity, fallback to first
    const mainTeam = ownerTeams.reduce((best, t) => {
      const count = users.filter(u => u.teamId === t.id).length + profiles.filter(p => p.teamId === t.id).length;
      const bestCount = users.filter(u => u.teamId === best.id).length + profiles.filter(p => p.teamId === best.id).length;
      return count > bestCount ? t : best;
    }, ownerTeams[0]);
    return { team: mainTeam, owner, members, instanceCount, duplicateCount: ownerTeams.length };
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Crown size={22} style={{ color: '#f59e0b' }} />
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Admin Panel</h1>
          </div>
          <button onClick={loadAll} className="p-2 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent-light)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
            title="Rafraîchir">
            <RefreshCw size={16} />
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Utilisateurs', value: users.length, icon: <Users size={15} />, color: 'var(--accent)' },
            { label: 'Teams', value: teams.length, icon: <UsersRound size={15} />, color: '#8b5cf6' },
            { label: 'Instances', value: activeProfiles, icon: <Monitor size={15} />, color: 'var(--success)' },
            { label: 'Codes actifs', value: inviteCodes.filter(c => !c.used).length, icon: <Ticket size={15} />, color: '#ec4899' },
          ].map(s => (
            <div key={s.label} className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
              <div className="flex items-center gap-2 mb-1">
                <span style={{ color: s.color }}>{s.icon}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{s.label}</span>
              </div>
              <div className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Teams — each team = card with owner + members */}
        {teamData.map(({ team, owner, members, instanceCount, duplicateCount }) => (
          <div key={team.id} className="rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>

            {/* Team header */}
            <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <UsersRound size={18} style={{ color: 'var(--accent)' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{team.name}</span>
                  {duplicateCount > 1 && (
                    <>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>
                        {duplicateCount} teams fusionnées
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteEmptyTeams(team.ownerId, team.id); }}
                        className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors"
                        style={{ background: 'rgba(239,68,68,0.08)', color: 'var(--danger)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.15)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}>
                        <span className="flex items-center gap-1"><Trash2 size={10} /> Supprimer doublons</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <span><strong style={{ color: 'var(--text-primary)' }}>{members.length}</strong> membres</span>
                <span><strong style={{ color: 'var(--accent-light)' }}>{instanceCount}</strong> instances</span>
              </div>
              {/* Delete team — not for super admin's own team */}
              {team.ownerId !== SUPER_ADMIN_UID && (
                <button onClick={() => handleDeleteTeam(team.id, team.ownerId)}
                  className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                  title="Supprimer cette team">
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            {/* Owner */}
            <div className="px-5 py-3 flex items-center gap-3" style={{ background: 'rgba(245, 158, 11, 0.03)', borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0"
                style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}>
                {owner?.email?.charAt(0).toUpperCase() || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{owner?.email || 'inconnu'}</div>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase" style={{ background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' }}>
                OWNER
              </span>
              <span className="text-[12px] tabular-nums w-14 text-right" style={{ color: 'var(--text-muted)' }}>
                {owner ? profiles.filter(p => p.teamId === team.id && p.createdBy === owner.uid && !p.deleted).length : 0} inst.
              </span>
            </div>

            {/* Other members */}
            {members
              .filter(m => m.uid !== team.ownerId)
              .sort((a, b) => (a.role === 'admin' ? -1 : 1))
              .map(member => (
                <div key={member.uid} className="px-5 py-3 flex items-center gap-3 transition-colors"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

                  <div className="w-3 shrink-0" />
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0"
                    style={{ background: member.role === 'admin' ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : 'linear-gradient(135deg, #059669, #10b981)' }}>
                    {member.email?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{member.email}</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatDate(member.createdAt)}</div>
                  </div>

                  <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase" style={{
                    background: member.role === 'admin' ? 'var(--accent-subtle)' : 'rgba(16, 185, 129, 0.1)',
                    color: member.role === 'admin' ? 'var(--accent-light)' : 'var(--success)',
                  }}>
                    {member.role === 'admin' ? 'ADMIN' : 'VA'}
                  </span>

                  <span className="text-[12px] tabular-nums w-14 text-right" style={{ color: 'var(--text-muted)' }}>
                    {profiles.filter(p => p.teamId === team.id && p.createdBy === member.uid && !p.deleted).length} inst.
                  </span>

                  {/* Actions */}
                  <div className="shrink-0">
                    {member.uid !== SUPER_ADMIN_UID && (
                      <button onClick={(e) => openMenuAt(member.uid, e)}
                        className="p-1 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <MoreVertical size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ))}

            {members.filter(m => m.uid !== team.ownerId).length === 0 && (
              <div className="px-5 py-3 text-[12px] text-center" style={{ color: 'var(--text-muted)' }}>Pas d'autres membres</div>
            )}
          </div>
        ))}

        {/* Utilisateurs sans team visible */}
        {(() => {
          // Collect all user uids that already appear in a team card
          const shownUids = new Set<string>();
          for (const td of teamData) {
            if (td.owner) shownUids.add(td.owner.uid);
            for (const m of td.members) shownUids.add(m.uid);
          }
          const orphans = users.filter(u => !shownUids.has(u.uid));
          if (orphans.length === 0) return null;
          return (
            <div>
              <h2 className="text-[15px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Utilisateurs sans team</h2>
              <div className="rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
                {orphans.map(u => (
                  <div key={u.uid} className="px-5 py-3 flex items-center gap-3 transition-colors"
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white shrink-0"
                      style={{ background: 'linear-gradient(135deg, #6b7280, #9ca3af)' }}>
                      {u.email?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{u.email}</div>
                      <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>UID: {u.uid}</div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase" style={{
                      background: u.role === 'owner' ? 'rgba(245,158,11,0.1)' : u.role === 'admin' ? 'var(--accent-subtle)' : 'rgba(16,185,129,0.1)',
                      color: u.role === 'owner' ? '#f59e0b' : u.role === 'admin' ? 'var(--accent-light)' : 'var(--success)',
                    }}>
                      {u.role}
                    </span>
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{formatDate(u.createdAt)}</span>

                    {/* Actions */}
                    <div className="shrink-0">
                      {u.uid !== SUPER_ADMIN_UID && (
                        <button onClick={(e) => openMenuAt(u.uid, e)}
                          className="p-1 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <MoreVertical size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Codes d'invitation */}
        <div>
          <h2 className="text-[15px] font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Codes d'invitation</h2>
          <div className="rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div className="grid grid-cols-[1fr_70px_70px_130px_130px_40px] px-5 py-2.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
              <span>Code</span><span>Type</span><span>Statut</span><span>Créé par</span><span>Utilisé par</span><span></span>
            </div>

            {inviteCodes.map(code => {
              const creator = users.find(u => u.uid === code.createdBy);
              return (
                <div key={code.id} className="grid grid-cols-[1fr_70px_70px_130px_130px_40px] px-5 py-2.5 items-center transition-colors text-[12px]"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <span className="font-mono" style={{ color: code.used ? 'var(--text-muted)' : 'var(--text-primary)' }}>{code.id}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium w-fit"
                    style={{ background: code.codeType === 'personal' ? 'rgba(245,158,11,0.1)' : 'var(--accent-subtle)', color: code.codeType === 'personal' ? '#f59e0b' : 'var(--accent-light)' }}>
                    {code.codeType === 'personal' ? 'Perso' : 'Team'}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold w-fit"
                    style={{ background: code.used ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.1)', color: code.used ? 'var(--danger)' : 'var(--success)' }}>
                    {code.used ? 'Utilisé' : 'Actif'}
                  </span>
                  <span className="truncate" style={{ color: 'var(--text-muted)' }}>{creator?.email || '-'}</span>
                  <span className="truncate" style={{ color: 'var(--text-muted)' }}>{code.usedByEmail || '-'}</span>
                  <button onClick={() => handleDeleteCode(code.id)} className="p-1 rounded transition-colors" style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}

            {inviteCodes.length === 0 && (
              <div className="px-5 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>Aucun code</div>
            )}
          </div>
        </div>

      </div>

      {/* Floating menu — rendered via portal at body level, never clipped */}
      {menuOpenId && menuPos && ReactDOM.createPortal((() => {
        const u = users.find(x => x.uid === menuOpenId);
        if (!u) return null;
        const hasTeam = !!u.teamId && teams.some(t => t.id === u.teamId);
        const openUp = menuPos.top > window.innerHeight / 2;
        return (
          <div className="fixed rounded-lg shadow-2xl z-[9999] py-1 w-[220px] max-h-[350px] overflow-y-auto"
            style={{
              background: 'var(--bg-overlay)',
              border: '1px solid var(--border-default)',
              left: menuPos.left,
              ...(openUp ? { bottom: window.innerHeight - menuPos.top + 4 } : { top: menuPos.top + 28 }),
            }}
            onClick={e => e.stopPropagation()}>

            {/* Assign to team — only for orphans */}
            {!hasTeam && (
              <>
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  Ajouter à une team
                </div>
                {teamData.map(({ team, owner }) => (
                  <button key={team.id} onClick={() => { handleAssignTeam(u.uid, team.id); setMenuOpenId(null); }}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 transition-colors"
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <UsersRound size={12} style={{ color: 'var(--accent)' }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{team.name}</div>
                      <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{owner?.email || '-'}</div>
                    </div>
                  </button>
                ))}
                <div className="my-1" style={{ borderTop: '1px solid var(--border-subtle)' }} />
              </>
            )}

            {/* Change role */}
            {u.role !== 'admin' && (
              <button onClick={() => handleRoleChange(u.uid, 'admin')}
                className="w-full px-3 py-2 text-[13px] text-left flex items-center gap-2 transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <Shield size={13} /> Passer Admin
              </button>
            )}
            {u.role !== 'va' && (
              <button onClick={() => handleRoleChange(u.uid, 'va')}
                className="w-full px-3 py-2 text-[13px] text-left flex items-center gap-2 transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <Eye size={13} /> Passer VA
              </button>
            )}

            <div className="my-1" style={{ borderTop: '1px solid var(--border-subtle)' }} />

            <button onClick={() => handleDeleteUser(u.uid)}
              className="w-full px-3 py-2 text-[13px] text-left flex items-center gap-2 transition-colors"
              style={{ color: 'var(--danger)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <Trash2 size={13} /> Supprimer
            </button>
          </div>
        );
      })(), document.body)}
    </div>
  );
};

export default AdminPage;
