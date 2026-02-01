import React from 'react';
import { ChevronRight, Home } from 'lucide-react';
import { Folder } from '../../types';

interface FolderBreadcrumbProps {
  selectedFolderId: string | null;
  folders: Folder[];
  onNavigate: (folderId: string | null) => void;
}

const FolderBreadcrumb: React.FC<FolderBreadcrumbProps> = ({ selectedFolderId, folders, onNavigate }) => {
  const currentFolder = selectedFolderId ? folders.find(f => f.id === selectedFolderId) : null;

  return (
    <div className="flex items-center gap-1.5 text-[13px]">
      <button
        onClick={() => onNavigate(null)}
        className="flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors"
        style={{ color: currentFolder ? 'var(--text-muted)' : 'var(--text-primary)' }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
        onMouseLeave={e => { if (currentFolder) e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        <Home size={14} />
        <span className="font-medium">Instances</span>
      </button>

      {currentFolder && (
        <>
          <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
          <div className="flex items-center gap-1.5 px-1.5 py-0.5 font-medium" style={{ color: 'var(--text-primary)' }}>
            <span style={{ color: currentFolder.color }}>{currentFolder.icon || '📁'}</span>
            <span>{currentFolder.name}</span>
          </div>
        </>
      )}
    </div>
  );
};

export default FolderBreadcrumb;
