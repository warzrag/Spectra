import React, { useState } from 'react';
import { Home, Search, X } from 'lucide-react';
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
  const [searchTerm, setSearchTerm] = useState('');

  if (!isOpen) return null;

  const search = searchTerm.trim().toLowerCase();
  const getChildren = (parentId: string) => folders.filter(folder => folder.parentId === parentId);
  const folderMatches = (folder: FolderType): boolean => {
    if (!search) return true;
    if (folder.name.toLowerCase().includes(search)) return true;
    return getChildren(folder.id).some(folderMatches);
  };

  const rootFolders = folders.filter(folder => !folder.parentId).filter(folderMatches);

  const renderFolder = (folder: FolderType, depth = 0): React.ReactNode => {
    const children = getChildren(folder.id).filter(folderMatches);

    return (
      <React.Fragment key={folder.id}>
        <button
          onClick={() => setSelectedFolderId(folder.id)}
          className="w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-2.5 text-[13px] transition-colors"
          style={{
            paddingLeft: `${12 + depth * 18}px`,
            background: selectedFolderId === folder.id ? 'var(--accent-subtle, rgba(99,102,241,0.1))' : 'var(--bg-elevated)',
            border: selectedFolderId === folder.id ? '1px solid var(--accent)' : '1px solid transparent',
            color: selectedFolderId === folder.id ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          <span style={{ color: folder.color }}>{folder.icon || '\uD83D\uDCC1'}</span>
          <span className="flex-1 truncate">{folder.name}</span>
        </button>
        {children.map(child => renderFolder(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        className="rounded-xl p-6 w-[460px] shadow-2xl"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Move {selectedCount} Instance{selectedCount > 1 ? 's' : ''}
            </h2>
            <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Choose the destination folder.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={event => event.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={event => event.currentTarget.style.background = 'transparent'}
          >
            <X size={18} />
          </button>
        </div>

        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            value={searchTerm}
            onChange={event => setSearchTerm(event.target.value)}
            placeholder="Search folder..."
            className="w-full pl-9 pr-3 py-2 rounded-lg text-[13px]"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          />
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

          {rootFolders.map(folder => renderFolder(folder))}
          {rootFolders.length === 0 && (
            <div className="px-3 py-4 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
              No folder found
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-[13px] font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
          <button
            onClick={() => onMove(selectedFolderId)}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white"
            style={{ background: 'var(--accent)' }}
          >
            Move
          </button>
        </div>
      </div>
    </div>
  );
};

export default MoveFolderModal;
