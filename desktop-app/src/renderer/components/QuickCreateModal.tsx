import React, { useState } from 'react';
import { X, Zap, Loader2 } from 'lucide-react';
import { Folder as FolderType, Platform } from '../../types';

interface QuickCreateModalProps {
  onClose: () => void;
  onCreate: (profileData: any) => Promise<void> | void;
  folders: FolderType[];
}

const QuickCreateModal: React.FC<QuickCreateModalProps> = ({ onClose, onCreate, folders }) => {
  const [count, setCount] = useState(5);
  const [prefix, setPrefix] = useState('Instance');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [os, setOs] = useState<'windows' | 'macos' | 'linux'>('windows');
  const [browserType, setBrowserType] = useState<'chrome' | 'firefox' | 'edge'>('chrome');
  const [generateFingerprints, setGenerateFingerprints] = useState(true);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState(0);

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
  };

  const labelStyle: React.CSSProperties = {
    color: 'var(--text-secondary)',
  };

  const userAgents: Record<string, string> = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.82 Safari/537.36 Edg/140.0.0.0',
  };

  const platformUrls: Record<string, string> = {
    twitter: 'https://twitter.com',
    instagram: 'https://www.instagram.com',
    tiktok: 'https://www.tiktok.com',
    reddit: 'https://www.reddit.com',
    onlyfans: 'https://onlyfans.com',
    telegram: 'https://web.telegram.org',
  };

  const handleCreate = async () => {
    setCreating(true);
    setProgress(0);

    for (let i = 0; i < count; i++) {
      let fingerprint: any = {};
      if (generateFingerprints && window.electronAPI?.fingerprint) {
        try {
          fingerprint = await window.electronAPI.fingerprint.generate(os, browserType);
        } catch {}
      }

      const data: any = {
        name: `${prefix} ${i + 1}`,
        userAgent: fingerprint?.userAgent || userAgents[browserType],
        timezone: fingerprint?.timezone || 'UTC',
        language: fingerprint?.language || 'en-US',
        screenResolution: fingerprint?.screenResolution || '1920x1080',
        hardwareConcurrency: fingerprint?.hardwareConcurrency || 8,
        deviceMemory: fingerprint?.deviceMemory || 8,
        os,
        browserType,
        folderId,
        fingerprint,
        connectionType: 'system',
        connectionConfig: { type: 'system' },
        createdAt: new Date().toISOString(),
      };
      if (platform) data.platform = platform;
      if (platform && platformUrls[platform]) data.lastUrl = platformUrls[platform];
      await onCreate(data);

      setProgress(i + 1);
    }

    setCreating(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable" onClick={(e) => { if (e.target === e.currentTarget && !creating) onClose(); }}>
      <div className="rounded-xl w-full max-w-[95vw] sm:max-w-md overflow-hidden shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Zap size={18} style={{ color: 'var(--warning)' }} />
            Quick Create
          </h2>
          {!creating && (
            <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <X size={18} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {/* Count + Prefix */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Number of instances</label>
              <input type="number" min="1" max="100" value={count} onChange={e => setCount(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
                className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle} />
            </div>
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Name prefix</label>
              <input type="text" value={prefix} onChange={e => setPrefix(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}
                placeholder="Instance" />
            </div>
          </div>

          {/* Platform */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Platform</label>
            <select value={platform} onChange={e => setPlatform(e.target.value as Platform | '')}
              className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
              <option value="">No platform</option>
              <option value="twitter">𝕏 Twitter</option>
              <option value="instagram">📷 Instagram</option>
              <option value="tiktok">🎵 TikTok</option>
              <option value="reddit">🔴 Reddit</option>
              <option value="onlyfans">💙 OnlyFans</option>
              <option value="telegram">✈️ Telegram</option>
              <option value="other">🌐 Other</option>
            </select>
          </div>

          {/* Folder */}
          <div>
            <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Folder</label>
            <select value={folderId || ''} onChange={e => setFolderId(e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
              <option value="">No folder</option>
              {folders.map(f => <option key={f.id} value={f.id}>{f.icon || '\uD83D\uDCC1'} {f.name}</option>)}
            </select>
          </div>

          {/* OS + Browser */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>OS</label>
              <select value={os} onChange={e => setOs(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                <option value="windows">Windows</option>
                <option value="macos">macOS</option>
                <option value="linux">Linux</option>
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Browser</label>
              <select value={browserType} onChange={e => setBrowserType(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500" style={inputStyle}>
                <option value="chrome">Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="edge">Edge</option>
              </select>
            </div>
          </div>

          {/* Generate fingerprints */}
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
            <input type="checkbox" checked={generateFingerprints} onChange={e => setGenerateFingerprints(e.target.checked)}
              className="rounded border-gray-600 text-indigo-500 w-3.5 h-3.5" />
            <div>
              <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>Generate unique fingerprints</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Each instance gets a unique browser fingerprint</div>
            </div>
          </div>

          {/* Progress bar */}
          {creating && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Creating instances...</span>
                <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{progress}/{count}</span>
              </div>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-overlay)' }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${(progress / count) * 100}%`, background: 'var(--accent)' }} />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-end gap-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {!creating && (
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>
              Cancel
            </button>
          )}
          <button onClick={handleCreate} disabled={creating}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-all flex items-center gap-2"
            style={{ background: creating ? 'var(--text-muted)' : 'var(--accent)' }}>
            {creating ? <><Loader2 size={14} className="animate-spin" /> Creating...</> : <><Zap size={14} /> Create {count} Instances</>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default QuickCreateModal;
