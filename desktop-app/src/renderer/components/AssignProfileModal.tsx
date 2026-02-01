import React, { useState, useEffect } from 'react';
import { X, UserPlus, Loader2 } from 'lucide-react';
import { getAllUsers } from '../services/firestore-service';
import { UserProfile } from '../../types';

interface AssignProfileModalProps {
  profileName: string;
  currentAssignee?: string;
  onClose: () => void;
  onAssign: (userId: string | null, userEmail: string | null) => void;
}

const AssignProfileModal: React.FC<AssignProfileModalProps> = ({ profileName, currentAssignee, onClose, onAssign }) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUid, setSelectedUid] = useState<string>(currentAssignee || '');

  useEffect(() => {
    getAllUsers().then(u => {
      setUsers(u);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleAssign = () => {
    if (selectedUid === '') {
      onAssign(null, null);
    } else {
      const user = users.find(u => u.uid === selectedUid);
      onAssign(selectedUid, user?.email || null);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-xl w-full max-w-sm overflow-hidden shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3.5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 className="text-[14px] font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <UserPlus size={16} style={{ color: 'var(--accent)' }} />
            Assign Instance
          </h2>
          <button onClick={onClose} className="p-1 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Assign <strong style={{ color: 'var(--text-primary)' }}>{profileName}</strong> to a user
          </p>

          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : (
            <select
              value={selectedUid}
              onChange={e => setSelectedUid(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg text-[13px]"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            >
              <option value="">Unassigned</option>
              {users.map(u => (
                <option key={u.uid} value={u.uid}>
                  {u.email} ({u.role})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 flex justify-end gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[12px] font-medium"
            style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>
            Cancel
          </button>
          <button onClick={handleAssign} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white"
            style={{ background: 'var(--accent)' }}>
            Assign
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssignProfileModal;
