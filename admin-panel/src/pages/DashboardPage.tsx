import React, { useState, useEffect } from 'react';
import { Users, Shield, UserCheck, Activity, Monitor, Loader2 } from 'lucide-react';
import { getStats, getActivityLogs, ActivityLogEntry } from '../services/firestore-service';

const DashboardPage: React.FC = () => {
  const [stats, setStats] = useState({ totalUsers: 0, admins: 0, vas: 0, recentActions: 0, totalProfiles: 0 });
  const [recentLogs, setRecentLogs] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getStats(),
      getActivityLogs({ limitCount: 8 }),
    ]).then(([s, logs]) => {
      setStats(s);
      setRecentLogs(logs.entries);
    }).finally(() => setLoading(false));
  }, []);

  const formatDate = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const actionLabel = (action: string) => {
    const map: Record<string, { label: string; color: string }> = {
      profile_launched: { label: 'Launched', color: 'bg-green-500/10 text-green-400' },
      profile_closed: { label: 'Closed', color: 'bg-gray-500/10 text-gray-400' },
      profile_created: { label: 'Created', color: 'bg-blue-500/10 text-blue-400' },
      profile_deleted: { label: 'Deleted', color: 'bg-red-500/10 text-red-400' },
      profile_restored: { label: 'Restored', color: 'bg-yellow-500/10 text-yellow-400' },
      user_login: { label: 'Login', color: 'bg-indigo-500/10 text-indigo-400' },
      user_logout: { label: 'Logout', color: 'bg-gray-500/10 text-gray-400' },
      cookies_imported: { label: 'Cookie Import', color: 'bg-orange-500/10 text-orange-400' },
      cookies_exported: { label: 'Cookie Export', color: 'bg-orange-500/10 text-orange-400' },
    };
    return map[action] || { label: action, color: 'bg-gray-500/10 text-gray-400' };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-white">Dashboard</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <StatCard icon={<Users size={20} />} label="Total Users" value={stats.totalUsers} color="from-indigo-500 to-purple-600" />
        <StatCard icon={<Shield size={20} />} label="Admins" value={stats.admins} color="from-purple-500 to-pink-600" />
        <StatCard icon={<UserCheck size={20} />} label="VAs" value={stats.vas} color="from-emerald-500 to-teal-600" />
        <StatCard icon={<Monitor size={20} />} label="Profiles" value={stats.totalProfiles} color="from-blue-500 to-cyan-600" />
        <StatCard icon={<Activity size={20} />} label="Recent Actions" value={stats.recentActions} color="from-orange-500 to-red-600" />
      </div>

      {/* Recent Activity */}
      <div className="bg-gray-900 rounded-xl border border-gray-800">
        <div className="px-5 py-3.5 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">Recent Activity</h2>
        </div>
        <div className="divide-y divide-gray-800">
          {recentLogs.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-500 text-sm">No activity yet</div>
          ) : (
            recentLogs.map((log) => {
              const a = actionLabel(log.action);
              return (
                <div key={log.id} className="px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.color}`}>
                      {a.label}
                    </span>
                    <span className="text-sm text-gray-300">{log.userName}</span>
                    {log.targetProfileName && (
                      <span className="text-xs text-gray-500">- {log.targetProfileName}</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-500">{formatDate(log.timestamp)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

const StatCard: React.FC<{ icon: React.ReactNode; label: string; value: number; color: string }> = ({ icon, label, value, color }) => (
  <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
        <p className="text-2xl font-bold text-white mt-1">{value}</p>
      </div>
      <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${color} flex items-center justify-center text-white`}>
        {icon}
      </div>
    </div>
  </div>
);

export default DashboardPage;
