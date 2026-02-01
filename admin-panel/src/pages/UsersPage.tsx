import React, { useState, useEffect } from 'react';
import { UserPlus, Trash2, RefreshCw, Shield, UserCheck, Key, Loader2, X } from 'lucide-react';
import { getAllUsers, createUserDoc, updateUserRole, deleteUserDoc, UserProfile, UserRole } from '../services/firestore-service';
import { createUserAccount, resetPassword } from '../services/auth-service';

const UsersPage: React.FC = () => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('va');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadUsers = async () => {
    setLoading(true);
    const u = await getAllUsers();
    setUsers(u);
    setLoading(false);
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setCreating(true);

    try {
      // Create Firebase Auth account via REST API
      const uid = await createUserAccount(newEmail, newPassword);
      // Create Firestore user document
      await createUserDoc(uid, newEmail, newRole);
      setSuccess(`User ${newEmail} created as ${newRole.toUpperCase()}`);
      setNewEmail('');
      setNewPassword('');
      setNewRole('va');
      setShowCreate(false);
      await loadUsers();
    } catch (err: any) {
      const msg = err.message || 'Failed to create user';
      if (msg.includes('EMAIL_EXISTS')) {
        setError('This email is already registered.');
      } else if (msg.includes('WEAK_PASSWORD')) {
        setError('Password must be at least 6 characters.');
      } else if (msg.includes('INVALID_EMAIL')) {
        setError('Invalid email address.');
      } else {
        setError(msg);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleChangeRole = async (uid: string, currentRole: UserRole) => {
    const newR: UserRole = currentRole === 'admin' ? 'va' : 'admin';
    if (!window.confirm(`Change role to ${newR.toUpperCase()}?`)) return;
    await updateUserRole(uid, newR);
    setUsers(prev => prev.map(u => u.uid === uid ? { ...u, role: newR } : u));
    setSuccess(`Role updated to ${newR.toUpperCase()}`);
  };

  const handleDelete = async (user: UserProfile) => {
    if (!window.confirm(`Remove ${user.email} from the system? They won't be able to access Spectra anymore.`)) return;
    await deleteUserDoc(user.uid);
    setUsers(prev => prev.filter(u => u.uid !== user.uid));
    setSuccess(`${user.email} removed`);
  };

  const handleReset = async (email: string) => {
    try {
      await resetPassword(email);
      setSuccess(`Password reset email sent to ${email}`);
    } catch (err: any) {
      setError('Failed to send reset email');
    }
  };

  const formatDate = (ts: string) => {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Users</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={loadUsers}
            className="p-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => { setShowCreate(true); setError(''); setSuccess(''); }}
            className="px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-lg text-sm font-medium flex items-center gap-2 hover:opacity-90 transition-opacity"
          >
            <UserPlus size={16} />
            New User
          </button>
        </div>
      </div>

      {/* Messages */}
      {success && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-2.5 text-green-400 text-sm flex items-center justify-between">
          {success}
          <button onClick={() => setSuccess('')} className="text-green-400/60 hover:text-green-400"><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5 text-red-400 text-sm flex items-center justify-between">
          {error}
          <button onClick={() => setError('')} className="text-red-400/60 hover:text-red-400"><X size={14} /></button>
        </div>
      )}

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={e => { if (e.target === e.currentTarget) setShowCreate(false); }}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <UserPlus size={16} className="text-indigo-400" />
                Create User
              </h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <form onSubmit={handleCreate} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="user@example.com"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                  placeholder="Minimum 6 characters"
                  minLength={6}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">Role</label>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setNewRole('va')}
                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 border transition-colors ${
                      newRole === 'va' ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400' : 'bg-gray-800 border-gray-700 text-gray-400'
                    }`}
                  >
                    <UserCheck size={16} />
                    VA
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewRole('admin')}
                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 border transition-colors ${
                      newRole === 'admin' ? 'bg-purple-500/10 border-purple-500 text-purple-400' : 'bg-gray-800 border-gray-700 text-gray-400'
                    }`}
                  >
                    <Shield size={16} />
                    Admin
                  </button>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-2 bg-gray-800 text-gray-400 rounded-lg text-sm">
                  Cancel
                </button>
                <button type="submit" disabled={creating} className="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50">
                  {creating ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-gray-500" />
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-12 text-gray-500 text-sm">No users found</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">User</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Role</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Created</th>
                <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {users.map(user => (
                <tr key={user.uid} className="hover:bg-gray-800/50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${
                        user.role === 'admin' ? 'bg-gradient-to-br from-indigo-500 to-purple-600' : 'bg-gradient-to-br from-emerald-500 to-teal-600'
                      }`}>
                        {user.email.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm text-white">{user.email}</div>
                        <div className="text-xs text-gray-500 font-mono">{user.uid.slice(0, 12)}...</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      user.role === 'admin' ? 'bg-purple-500/10 text-purple-400' : 'bg-emerald-500/10 text-emerald-400'
                    }`}>
                      {user.role === 'admin' ? <Shield size={10} /> : <UserCheck size={10} />}
                      {user.role.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-gray-400">
                    {user.createdAt ? formatDate(user.createdAt) : '-'}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleChangeRole(user.uid, user.role)}
                        className="p-1.5 rounded-lg text-gray-500 hover:text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                        title="Toggle role"
                      >
                        <RefreshCw size={14} />
                      </button>
                      <button
                        onClick={() => handleReset(user.email)}
                        className="p-1.5 rounded-lg text-gray-500 hover:text-yellow-400 hover:bg-yellow-500/10 transition-colors"
                        title="Reset password"
                      >
                        <Key size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(user)}
                        className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Delete user"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default UsersPage;
