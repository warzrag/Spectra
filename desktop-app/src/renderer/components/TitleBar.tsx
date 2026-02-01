import React from 'react';
import { Minus, Square, X } from 'lucide-react';

const TitleBar: React.FC = () => {
  const handleMinimize = () => window.electronAPI.window.minimize();
  const handleMaximize = () => window.electronAPI.window.maximize();
  const handleClose = () => window.electronAPI.window.close();

  return (
    <div className="h-9 flex items-center justify-end draggable" style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center non-draggable">
        <button
          onClick={handleMinimize}
          className="h-9 w-12 flex items-center justify-center transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <Minus size={15} />
        </button>
        <button
          onClick={handleMaximize}
          className="h-9 w-12 flex items-center justify-center transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <Square size={12} />
        </button>
        <button
          onClick={handleClose}
          className="h-9 w-12 flex items-center justify-center transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.background = '#dc2626'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
