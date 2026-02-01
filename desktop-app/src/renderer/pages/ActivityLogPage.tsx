import React, { useState, useEffect } from 'react';
import { Clock, RefreshCw, Filter, User, Loader2 } from 'lucide-react';
import { getActivityLogs, getAllUsers, ActivityLogFilters } from '../services/firestore-service';
import { ActivityLogEntry, UserProfile } from '../../types';

const actionLabels: Record<string, { label: string; color: string; bg: string }> = {
  profile_launched: { label: 'Launched', color: 'var(--success)', bg: 'var(--success-subtle)' },
  profile_closed: { label: 'Closed', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
  profile_created: { label: 'Created', color: 'var(--accent-light)', bg: 'var(--accent-subtle)' },
  profile_deleted: { label: 'Deleted', color: 'var(--danger)', bg: 'var(--danger-subtle)' },
  profile_restored: { label: 'Restored', color: 'var(--success)', bg: 'var(--success-subtle)' },
  profile_permanently_deleted: { label: 'Purged', color: 'var(--danger)', bg: 'var(--danger-subtle)' },
  user_login: { label: 'Login', color: 'var(--accent-light)', bg: 'var(--accent-subtle)' },
  user_logout: { label: 'Logout', color: 'var(--warning)', bg: 'var(--warning-subtle)' },
  cookies_imported: { label: 'Cookies In', color: 'var(--accent-light)', bg: 'var(--accent-subtle)' },
  cookies_exported: { label: 'Cookies Out', color: 'var(--accent-light)', bg: 'var(--accent-subtle)' },
};

const ActivityLogPage: React.FC = () => {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [filterUser, setFilterUser] = useState<string>('');
  const [filterAction, setFilterAction] = useState<string>('');

  useEffect(() => {
    loadInitial();
    getAllUsers().then(setUsers).catch(() => {});
  }, [filterUser, filterAction]);

  const loadInitial = async () => {
    setLoading(true);
    const filters: ActivityLogFilters = { limitCount: 50 };
    if (filterUser) filters.userId = filterUser;
    if (filterAction) filters.action = filterAction;
    const result = await getActivityLogs(filters);
    setEntries(result.entries);
    setLastDoc(result.lastDoc);
    setHasMore(result.entries.length === 50);
    setLoading(false);
  };

  const loadMore = async () => {
    if (!lastDoc || loadingMore) return;
    setLoadingMore(true);
    const filters: ActivityLogFilters = { limitCount: 50, lastDoc };
    if (filterUser) filters.userId = filterUser;
    if (filterAction) filters.action = filterAction;
    const result = await getActivityLogs(filters);
    setEntries(prev => [...prev, ...result.entries]);
    setLastDoc(result.lastDoc);
    setHasMore(result.entries.length === 50);
    setLoadingMore(false);
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Activity Log</h1>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Monitor all user actions</p>
        </div>
        <button onClick={loadInitial} className="p-2 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <RefreshCw size={18} />
        </button>
      </div>

      {/* Filters */}
      <div className="px-6 py-3 flex items-center gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <Filter size={14} style={{ color: 'var(--text-muted)' }} />
        <select value={filterUser} onChange={e => setFilterUser(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-[12px]"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
          <option value="">All users</option>
          {users.map(u => <option key={u.uid} value={u.uid}>{u.email}</option>)}
        </select>
        <select value={filterAction} onChange={e => setFilterAction(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-[12px]"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
          <option value="">All actions</option>
          {Object.entries(actionLabels).map(([key, val]) => (
            <option key={key} value={key}>{val.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <Clock size={32} style={{ color: 'var(--text-muted)' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>No activity logged yet</p>
          </div>
        ) : (
          <table className="w-full min-w-[600px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th className="text-left px-6 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Time</th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>User</th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Action</th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Instance</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => {
                const actionInfo = actionLabels[entry.action] || { label: entry.action, color: 'var(--text-muted)', bg: 'var(--bg-elevated)' };
                return (
                  <tr key={entry.id || i} className="transition-colors"
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td className="px-6 py-2.5 text-[12px] tabular-nums whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {formatTime(entry.timestamp)}
                    </td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      <div className="flex items-center gap-1.5">
                        <User size={12} />
                        {entry.userName}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium"
                        style={{ color: actionInfo.color, background: actionInfo.bg }}>
                        {actionInfo.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[12px]" style={{ color: 'var(--text-primary)' }}>
                      {entry.targetProfileName || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {hasMore && !loading && entries.length > 0 && (
          <div className="px-6 py-4 flex justify-center">
            <button onClick={loadMore} disabled={loadingMore}
              className="px-4 py-2 rounded-lg text-[12px] font-medium transition-colors flex items-center gap-2"
              style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
              {loadingMore ? <><Loader2 size={14} className="animate-spin" /> Loading...</> : 'Load More'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivityLogPage;
