import React, { useState, useEffect } from 'react';
import { Trash2, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react';
import { Profile } from '../../types';

interface RecycleBinPageProps {
  deletedProfiles: Profile[];
  onRestore: (profileId: string) => void;
  onPermanentDelete: (profileId: string) => void;
  onEmptyBin: () => void;
}

const RecycleBinPage: React.FC<RecycleBinPageProps> = ({ deletedProfiles, onRestore, onPermanentDelete, onEmptyBin }) => {
  const formatDate = (ts?: string) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
  };

  const daysLeft = (deletedAt?: string) => {
    if (!deletedAt) return 30;
    const deleted = new Date(deletedAt).getTime();
    const now = Date.now();
    const diffDays = 30 - Math.floor((now - deleted) / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Trash2 size={20} style={{ color: 'var(--text-muted)' }} />
            Recycle Bin
          </h1>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {deletedProfiles.length} deleted instance{deletedProfiles.length !== 1 ? 's' : ''} — auto-purged after 30 days
          </p>
        </div>
        {deletedProfiles.length > 0 && (
          <button
            onClick={() => {
              if (window.confirm('Permanently delete ALL items in the recycle bin? This cannot be undone.')) {
                onEmptyBin();
              }
            }}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors"
            style={{ color: 'var(--danger)', background: 'var(--danger-subtle)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
          >
            <Trash2 size={13} />
            Empty Bin
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-auto">
        {deletedProfiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
              <Trash2 size={28} style={{ color: 'var(--text-muted)' }} />
            </div>
            <p className="text-[14px] font-medium" style={{ color: 'var(--text-secondary)' }}>Recycle bin is empty</p>
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Deleted instances will appear here</p>
          </div>
        ) : (
          <table className="w-full min-w-[600px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th className="text-left px-6 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Instance</th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Deleted At</th>
                <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Days Left</th>
                <th className="text-right px-6 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {deletedProfiles.map(profile => {
                const remaining = daysLeft(profile.deletedAt);
                return (
                  <tr key={profile.id} className="transition-colors"
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td className="px-6 py-3">
                      <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{profile.name}</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{profile.os || 'windows'} / {profile.browserType || 'chrome'}</div>
                    </td>
                    <td className="px-4 py-3 text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {formatDate(profile.deletedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[12px] tabular-nums font-medium" style={{
                        color: remaining <= 7 ? 'var(--danger)' : remaining <= 14 ? 'var(--warning)' : 'var(--text-secondary)'
                      }}>
                        {remaining} days
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => onRestore(profile.id)}
                          className="px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors"
                          style={{ color: 'var(--success)', background: 'var(--success-subtle)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'var(--success-subtle)'}
                        >
                          <RotateCcw size={11} /> Restore
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`Permanently delete "${profile.name}"? This cannot be undone.`)) {
                              onPermanentDelete(profile.id);
                            }
                          }}
                          className="px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors"
                          style={{ color: 'var(--danger)', background: 'var(--danger-subtle)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                        >
                          <Trash2 size={11} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default RecycleBinPage;
