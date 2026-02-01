import React, { useState } from 'react';
import { X } from 'lucide-react';

interface FolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; icon?: string; color?: string }) => void;
  folder?: { id: string; name: string; icon?: string; color?: string };
}

const FOLDER_ICONS = ['📁', '📂', '🗂️', '📋', '📦', '🎯', '💼', '🏪', '🛒', '💎'];
const FOLDER_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#3b82f6', '#84cc16'];

const FolderModal: React.FC<FolderModalProps> = ({ isOpen, onClose, onSubmit, folder }) => {
  const [name, setName] = useState(folder?.name || '');
  const [selectedIcon, setSelectedIcon] = useState(folder?.icon || '📁');
  const [selectedColor, setSelectedColor] = useState(folder?.color || '#6366f1');

  React.useEffect(() => {
    if (isOpen) {
      setName(folder?.name || '');
      setSelectedIcon(folder?.icon || '📁');
      setSelectedColor(folder?.color || '#6366f1');
    }
  }, [isOpen, folder]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onSubmit({ name: name.trim(), icon: selectedIcon, color: selectedColor });
      setName('');
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable">
      <div className="rounded-xl p-6 w-[440px] shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            {folder ? 'Edit Folder' : 'New Folder'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              placeholder="Folder name" autoFocus />
          </div>

          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Icon</label>
            <div className="flex gap-1.5 flex-wrap">
              {FOLDER_ICONS.map(icon => (
                <button key={icon} type="button" onClick={() => setSelectedIcon(icon)}
                  className="w-9 h-9 text-lg rounded-lg flex items-center justify-center transition-all"
                  style={{
                    border: selectedIcon === icon ? '2px solid var(--accent)' : '1px solid var(--border-default)',
                    background: selectedIcon === icon ? 'var(--accent-subtle, rgba(99,102,241,0.12))' : 'var(--bg-elevated)',
                  }}>
                  {icon}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Color</label>
            <div className="flex gap-1.5 flex-wrap">
              {FOLDER_COLORS.map(color => (
                <button key={color} type="button" onClick={() => setSelectedColor(color)}
                  className="w-8 h-8 rounded-lg transition-all"
                  style={{
                    backgroundColor: color,
                    border: selectedColor === color ? '2px solid white' : '2px solid transparent',
                    transform: selectedColor === color ? 'scale(1.1)' : 'scale(1)',
                  }} />
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
              style={{ color: 'var(--text-secondary)' }}>
              Cancel
            </button>
            <button type="submit"
              className="px-4 py-2 rounded-lg text-[13px] font-medium text-white"
              style={{ background: 'var(--accent)' }}>
              {folder ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default FolderModal;
