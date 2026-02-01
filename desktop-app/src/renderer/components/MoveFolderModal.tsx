import React, { useState } from 'react';
import { X, Home } from 'lucide-react';
import { Folder as FolderType } from '../../types';

interface MoveFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  folders: FolderType[];
  selectedCount: number;
  onMove: (folderId: string | null) => void;
}

const MoveFolderModal: React.FC<MoveFolderModalProps> = ({ isOpen, onClose, folders, selectedCount, onMove }) => {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable">
      <div className="rounded-xl p-6 w-[440px] shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Move {selectedCount} Instance{selectedCount > 1 ? 's' : ''}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <X size={18} />
          </button>
        </div>

        <div className="space-y-1 mb-5 max-h-72 overflow-y-auto">
          <button
            onClick={() => setSelectedFolderId(null)}
            className="w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-2.5 text-[13px] transition-colors"
            style={{
              background: selectedFolderId === null ? 'var(--accent-subtle, rgba(99,102,241,0.1))' : 'var(--bg-elevated)',
              border: selectedFolderId === null ? '1px solid var(--accent)' : '1px solid transparent',
              color: selectedFolderId === null ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Home size={16} />
            <span className="flex-1 font-medium">Root (All Instances)</span>
          </button>

          {folders.map(folder => (
            <button key={folder.id}
              onClick={() => setSelectedFolderId(folder.id)}
              className="w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-2.5 text-[13px] transition-colors"
              style={{
                background: selectedFolderId === folder.id ? 'var(--accent-subtle, rgba(99,102,241,0.1))' : 'var(--bg-elevated)',
                border: selectedFolderId === folder.id ? '1px solid var(--accent)' : '1px solid transparent',
                color: selectedFolderId === folder.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              <span style={{ color: folder.color }}>{folder.icon || '📁'}</span>
              <span className="flex-1">{folder.name}</span>
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-3">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            Cancel
          </button>
          <button onClick={() => { onMove(selectedFolderId); onClose(); }}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white" style={{ background: 'var(--accent)' }}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
};

export default MoveFolderModal;
