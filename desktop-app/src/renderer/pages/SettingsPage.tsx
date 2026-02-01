import React from 'react';
import { Sun, Moon, Monitor, Globe, Info, User, LogOut, Shield } from 'lucide-react';
import { AppSettings, AppUser } from '../../types';

interface SettingsPageProps {
  settings: AppSettings;
  onSettingsChange: (settings: Partial<AppSettings>) => void;
  user: AppUser | null;
  onLogout: () => void;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ settings, onSettingsChange, user, onLogout }) => {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Settings</h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>Customize your Spectra experience</p>
        </div>

        {/* Account */}
        {user && (
          <section>
            <h2 className="text-[14px] font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <User size={16} style={{ color: 'var(--accent)' }} />
              Account
            </h2>
            <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold text-white shrink-0"
                  style={{ background: user.role === 'admin' ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : 'linear-gradient(135deg, #059669, #10b981)' }}>
                  {user.email.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1">
                  <div className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>{user.email}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase"
                      style={{
                        background: user.role === 'admin' ? 'var(--accent-subtle)' : 'var(--success-subtle)',
                        color: user.role === 'admin' ? 'var(--accent-light)' : 'var(--success)',
                      }}>
                      <Shield size={10} className="inline mr-1" style={{ marginTop: -1 }} />
                      {user.role}
                    </span>
                  </div>
                </div>
                <button
                  onClick={onLogout}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors"
                  style={{ color: 'var(--danger)', background: 'var(--danger-subtle)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                >
                  <LogOut size={13} />
                  Sign Out
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Appearance */}
        <section>
          <h2 className="text-[14px] font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Sun size={16} style={{ color: 'var(--accent)' }} />
            Appearance
          </h2>
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <label className="block text-[12px] font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Theme</label>
            <div className="flex gap-3">
              <button
                onClick={() => onSettingsChange({ theme: 'dark' })}
                className="flex-1 p-4 rounded-lg flex flex-col items-center gap-2 transition-all"
                style={{
                  background: settings.theme === 'dark' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                  border: `2px solid ${settings.theme === 'dark' ? 'var(--accent)' : 'var(--border-default)'}`,
                }}
              >
                <Moon size={20} style={{ color: settings.theme === 'dark' ? 'var(--accent)' : 'var(--text-muted)' }} />
                <span className="text-[12px] font-medium" style={{ color: settings.theme === 'dark' ? 'var(--accent-light)' : 'var(--text-secondary)' }}>Dark</span>
              </button>
              <button
                onClick={() => onSettingsChange({ theme: 'light' })}
                className="flex-1 p-4 rounded-lg flex flex-col items-center gap-2 transition-all"
                style={{
                  background: settings.theme === 'light' ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                  border: `2px solid ${settings.theme === 'light' ? 'var(--accent)' : 'var(--border-default)'}`,
                }}
              >
                <Sun size={20} style={{ color: settings.theme === 'light' ? 'var(--accent)' : 'var(--text-muted)' }} />
                <span className="text-[12px] font-medium" style={{ color: settings.theme === 'light' ? 'var(--accent-light)' : 'var(--text-secondary)' }}>Light</span>
              </button>
            </div>
          </div>
        </section>

        {/* General */}
        <section>
          <h2 className="text-[14px] font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Globe size={16} style={{ color: 'var(--accent)' }} />
            General
          </h2>
          <div className="rounded-xl p-4 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div>
              <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Language</label>
              <select
                value={settings.language}
                onChange={(e) => onSettingsChange({ language: e.target.value })}
                className="w-full px-3 py-2 rounded-lg text-[13px]"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              >
                <option value="en-US">English (US)</option>
                <option value="fr-FR">Fran\u00e7ais</option>
                <option value="es-ES">Espa\u00f1ol</option>
                <option value="de-DE">Deutsch</option>
                <option value="pt-BR">Portugu\u00eas (BR)</option>
                <option value="ru-RU">\u0420\u0443\u0441\u0441\u043a\u0438\u0439</option>
                <option value="zh-CN">\u4e2d\u6587</option>
              </select>
            </div>
          </div>
        </section>

        {/* Default Profile Settings */}
        <section>
          <h2 className="text-[14px] font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Monitor size={16} style={{ color: 'var(--accent)' }} />
            Default Instance Settings
          </h2>
          <div className="rounded-xl p-4 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Default OS</label>
                <select
                  value={settings.defaultOS}
                  onChange={(e) => onSettingsChange({ defaultOS: e.target.value as any })}
                  className="w-full px-3 py-2 rounded-lg text-[13px]"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                >
                  <option value="windows">Windows</option>
                  <option value="macos">macOS</option>
                  <option value="linux">Linux</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Default Browser</label>
                <select
                  value={settings.defaultBrowser}
                  onChange={(e) => onSettingsChange({ defaultBrowser: e.target.value as any })}
                  className="w-full px-3 py-2 rounded-lg text-[13px]"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                >
                  <option value="chrome">Chrome</option>
                  <option value="firefox">Firefox</option>
                  <option value="edge">Edge</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Sort instances by</label>
                <select
                  value={settings.sortBy}
                  onChange={(e) => onSettingsChange({ sortBy: e.target.value as any })}
                  className="w-full px-3 py-2 rounded-lg text-[13px]"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                >
                  <option value="name">Name</option>
                  <option value="created">Date Created</option>
                  <option value="lastUsed">Last Used</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Sort order</label>
                <select
                  value={settings.sortOrder}
                  onChange={(e) => onSettingsChange({ sortOrder: e.target.value as any })}
                  className="w-full px-3 py-2 rounded-lg text-[13px]"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* About */}
        <section>
          <h2 className="text-[14px] font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Info size={16} style={{ color: 'var(--accent)' }} />
            About
          </h2>
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #6366f1, #7c3aed)' }}>
                <span className="text-white font-bold text-lg">S</span>
              </div>
              <div>
                <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Spectra Browser</div>
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Version 1.0.0</div>
                <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Antidetect browser specializing in OFM agency management. Manage your instances with unique fingerprints.
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default SettingsPage;
