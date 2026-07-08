import React, { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Copy, Monitor, RefreshCw, Shield, User } from 'lucide-react';
import { AppUser, Profile } from '../../types';

const INTERNAL_BUILD = {
  channel: 'internal',
  label: 'Spectra Internal Build',
  branch: 'internal-local-safety-work',
  suffix: 'dev',
};

interface DiagnosticsPageProps {
  user: AppUser | null;
  profiles: Profile[];
  activeProfiles: string[];
}

interface DiagnosticState {
  appVersion: string;
  hostname: string;
  currentIp: string;
  activeConnection: string;
  copied: boolean;
}

const DiagnosticsPage: React.FC<DiagnosticsPageProps> = ({ user, profiles, activeProfiles }) => {
  const [state, setState] = useState<DiagnosticState>({
    appVersion: '',
    hostname: '',
    currentIp: '',
    activeConnection: '',
    copied: false,
  });
  const [loading, setLoading] = useState(false);

  const loadDiagnostics = async () => {
    setLoading(true);
    const [appVersion, hostname, currentIp, activeConnection] = await Promise.all([
      window.electronAPI.getVersion().catch(() => ''),
      window.electronAPI.profileSync?.getHostname?.().catch(() => '') || Promise.resolve(''),
      window.electronAPI.network?.getCurrentIP?.().catch(() => '') || Promise.resolve(''),
      window.electronAPI.network?.getActiveConnection?.().catch(() => null) || Promise.resolve(null),
    ]);

    setState(prev => ({
      ...prev,
      appVersion,
      hostname,
      currentIp: currentIp || 'Unavailable',
      activeConnection: activeConnection?.name || activeConnection?.interfaceName || 'Unavailable',
    }));
    setLoading(false);
  };

  useEffect(() => {
    loadDiagnostics();
  }, []);

  const diagnosticsText = [
    `${INTERNAL_BUILD.label}`,
    `Channel: ${INTERNAL_BUILD.channel}`,
    `Branch: ${INTERNAL_BUILD.branch}`,
    `Version: ${state.appVersion || 'unknown'}-${INTERNAL_BUILD.suffix}`,
    `User: ${user?.email || 'signed out'}`,
    `Role: ${user?.role || 'unknown'}`,
    `Team: ${user?.teamId || 'unknown'}`,
    `Hostname: ${state.hostname || 'unknown'}`,
    `Current IP: ${state.currentIp}`,
    `Active connection: ${state.activeConnection}`,
    `Profiles: ${profiles.length}`,
    `Running profiles: ${activeProfiles.length}`,
  ].join('\n');

  const copyDiagnostics = async () => {
    await navigator.clipboard.writeText(diagnosticsText);
    setState(prev => ({ ...prev, copied: true }));
    window.setTimeout(() => setState(prev => ({ ...prev, copied: false })), 1600);
  };

  const rows = [
    ['Build channel', INTERNAL_BUILD.channel],
    ['Branch', INTERNAL_BUILD.branch],
    ['App version', state.appVersion ? `${state.appVersion}-${INTERNAL_BUILD.suffix}` : 'Unknown'],
    ['Signed-in user', user?.email || 'Unknown'],
    ['Role', user?.role || 'Unknown'],
    ['Team ID', user?.teamId || 'Unknown'],
    ['Device', state.hostname || 'Unknown'],
    ['Current IP', state.currentIp || 'Unknown'],
    ['Active connection', state.activeConnection || 'Unknown'],
    ['Total profiles', String(profiles.length)],
    ['Running profiles', String(activeProfiles.length)],
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span
                className="px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wider"
                style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}
              >
                Internal
              </span>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Not for customer release
              </span>
            </div>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              Diagnostics
            </h1>
            <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>
              Local build, account, browser, and support information.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={loadDiagnostics}
              className="px-3 py-2 rounded-lg text-[12px] font-medium flex items-center gap-2 transition-colors"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              onClick={copyDiagnostics}
              className="px-3 py-2 rounded-lg text-[12px] font-medium flex items-center gap-2 transition-colors"
              style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}
            >
              <Copy size={14} />
              {state.copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <section
          className="rounded-xl p-4"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
              <AlertTriangle size={18} />
            </div>
            <div>
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {INTERNAL_BUILD.label}
              </div>
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                This build is isolated for local development and should not be published to customers.
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rows.map(([label, value]) => (
              <div key={label} className="rounded-lg p-3" style={{ background: 'var(--bg-elevated)' }}>
                <div className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {label}
                </div>
                <div className="text-[13px] mt-1 break-all" style={{ color: 'var(--text-primary)' }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <StatusTile icon={<Shield size={18} />} label="Build isolation" value="Local branch" healthy />
          <StatusTile icon={<User size={18} />} label="Authentication" value={user ? 'Signed in' : 'No user'} healthy={Boolean(user)} />
          <StatusTile icon={<Monitor size={18} />} label="Browser sessions" value={`${activeProfiles.length} running`} healthy />
        </section>
      </div>
    </div>
  );
};

interface StatusTileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  healthy: boolean;
}

const StatusTile: React.FC<StatusTileProps> = ({ icon, label, value, healthy }) => (
  <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
    <div className="flex items-center justify-between mb-3">
      <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-elevated)', color: 'var(--accent-light)' }}>
        {icon}
      </div>
      {healthy ? (
        <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
      ) : (
        <Activity size={16} style={{ color: 'var(--warning)' }} />
      )}
    </div>
    <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
    <div className="text-[14px] font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>{value}</div>
  </div>
);

export default DiagnosticsPage;
