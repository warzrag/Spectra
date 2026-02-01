import React, { useState, useEffect } from 'react';
import { Activity, ChevronLeft, ChevronRight, Filter, Loader2 } from 'lucide-react';
import { getActivityLogs, getAllUsers, ActivityLogEntry, UserProfile } from '../services/firestore-service';

const ActivityPage: React.FC = () => {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterUser, setFilterUser] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);

  const loadLogs = async (reset = false) => {
    setLoading(true);
    const filters: any = { limitCount: 30 };
    if (filterUser) filters.userId = filterUser;
    if (filterAction) filters.action = filterAction;
    if (!reset && lastDoc) filters.lastDoc = lastDoc;

    const result = await getActivityLogs(filters);
    setEntries(result.entries);
    setLastDoc(result.lastDoc);
    setHasMore(result.entries.length === 30);
    setLoading(false);
  };

  useEffect(() => {
    Promise.all([loadLogs(true), getAllUsers().then(setUsers)]);
  }, []);

  const handleFilter = () => {
    setPage(1);
    setLastDoc(null);
    loadLogs(true);
  };

  const handleNext = () => {
    setPage(p => p + 1);
    loadLogs();
  };

  const formatDate = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const actionBadge = (action: string) => {
    const map: Record<string, { label: string; color: string }> = {
      profile_launched: { label: 'Launched', color: 'bg-green-500/10 text-green-400' },
      profile_closed: { label: 'Closed', color: 'bg-gray-500/10 text-gray-400' },
      profile_created: { label: 'Created', color: 'bg-blue-500/10 text-blue-400' },
      profile_deleted: { label: 'Deleted', color: 'bg-red-500/10 text-red-400' },
      profile_restored: { label: 'Restored', color: 'bg-yellow-500/10 text-yellow-400' },
      profile_permanently_deleted: { label: 'Perm. Deleted', color: 'bg-red-500/10 text-red-400' },
      user_login: { label: 'Login', color: 'bg-indigo-500/10 text-indigo-400' },
      user_logout: { label: 'Logout', color: 'bg-gray-500/10 text-gray-400' },
      cookies_imported: { label: 'Cookie Import', color: 'bg-orange-500/10 text-orange-400' },
      cookies_exported: { label: 'Cookie Export', color: 'bg-orange-500/10 text-orange-400' },
    };
    return map[action] || { label: action, color: 'bg-gray-500/10 text-gray-400' };
  };

  const actions = [
    'profile_launched', 'profile_closed', 'profile_created', 'profile_deleted',
    'profile_restored', 'user_login', 'user_logout', 'cookies_imported', 'cookies_exported',
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-white flex items-center gap-2">
        <Activity size={22} className="text-indigo-400" />
        Activity Logs
      </h1>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <select
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
        >
          <option value="">All Users</option>
          {users.map(u => (
            <option key={u.uid} value={u.uid}>{u.email}</option>
          ))}
        </select>

        <select
          value={filterAction}
          onChange={e => setFilterAction(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
        >
          <option value="">All Actions</option>
          {actions.map(a => (
            <option key={a} value={a}>{actionBadge(a).label}</option>
          ))}
        </select>

        <button
          onClick={handleFilter}
          className="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm font-medium flex items-center gap-2 hover:opacity-90 transition-opacity"
        >
          <Filter size={14} />
          Filter
        </button>
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-gray-500" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 text-gray-500 text-sm">No activity logs</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Time</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">User</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Action</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {entries.map(entry => {
                const badge = actionBadge(entry.action);
                return (
                  <tr key={entry.id} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-5 py-3 text-sm text-gray-400 whitespace-nowrap">
                      {formatDate(entry.timestamp)}
                    </td>
                    <td className="px-5 py-3 text-sm text-white">
                      {entry.userName}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${badge.color}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-400">
                      {entry.targetProfileName || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">Page {page}</span>
        <div className="flex gap-2">
          <button
            onClick={() => { setPage(1); setLastDoc(null); loadLogs(true); }}
            disabled={page === 1}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400 disabled:opacity-30 hover:text-white transition-colors flex items-center gap-1"
          >
            <ChevronLeft size={14} />
            First
          </button>
          <button
            onClick={handleNext}
            disabled={!hasMore}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400 disabled:opacity-30 hover:text-white transition-colors flex items-center gap-1"
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ActivityPage;
