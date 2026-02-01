import React, { useState, useEffect } from 'react';
import { CheckCircle, XCircle, Loader, Eye, EyeOff } from 'lucide-react';

interface ConnectionSelectorProps {
  value?: any;
  onChange: (value: any) => void;
}

type ProxyMode = 'custom' | 'saved' | 'provider';
type ProxyProtocol = 'none' | 'http' | 'https' | 'socks4' | 'socks5';

interface SavedProxy {
  id: string;
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  provider?: string;
  isHealthy?: boolean;
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
};

const labelStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
};

const ConnectionSelector: React.FC<ConnectionSelectorProps> = ({ value, onChange }) => {
  // Determine initial state from value
  const hasProxy = value?.type === 'proxy' && value?.proxy?.host;

  const [mode, setMode] = useState<ProxyMode>(hasProxy && value?.proxy?.provider && value.proxy.provider !== 'custom' ? 'provider' : 'custom');
  const [protocol, setProtocol] = useState<ProxyProtocol>(hasProxy ? (value.proxy.type || 'http') : 'none');
  const [host, setHost] = useState(hasProxy ? value.proxy.host : '');
  const [port, setPort] = useState(hasProxy ? String(value.proxy.port) : '');
  const [login, setLogin] = useState(hasProxy ? (value.proxy.username || '') : '');
  const [password, setPassword] = useState(hasProxy ? (value.proxy.password || '') : '');
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [savedProxies, setSavedProxies] = useState<SavedProxy[]>([]);
  const [selectedSavedId, setSelectedSavedId] = useState('');
  const [provider, setProvider] = useState(hasProxy ? (value.proxy.provider || 'brightdata') : 'brightdata');

  // Load saved proxies when switching to "saved" mode
  useEffect(() => {
    if (mode === 'saved') {
      window.electronAPI?.proxy?.getAll().then((proxies: SavedProxy[]) => {
        setSavedProxies(proxies || []);
      }).catch(() => {});
    }
  }, [mode]);

  // Emit onChange whenever proxy fields change
  useEffect(() => {
    if (protocol === 'none') {
      onChange({ type: 'system' });
    } else if (host && port) {
      onChange({
        type: 'proxy',
        proxy: {
          type: protocol,
          host,
          port: parseInt(port) || 0,
          username: login || undefined,
          password: password || undefined,
          provider: mode === 'provider' ? provider : 'custom',
        },
      });
    }
  }, [protocol, host, port, login, password, provider, mode]);

  const handleSelectSaved = (proxyId: string) => {
    setSelectedSavedId(proxyId);
    const proxy = savedProxies.find(p => p.id === proxyId);
    if (proxy) {
      setProtocol((proxy.type as ProxyProtocol) || 'http');
      setHost(proxy.host);
      setPort(String(proxy.port));
      setLogin(proxy.username || '');
      setPassword(proxy.password || '');
    }
  };

  const handleProviderChange = (p: string) => {
    setProvider(p);
    // Pre-fill with provider defaults
    const defaults: Record<string, { host: string; port: string; protocol: ProxyProtocol }> = {
      brightdata: { host: 'brd.superproxy.io', port: '22225', protocol: 'http' },
      smartproxy: { host: 'gate.smartproxy.com', port: '10000', protocol: 'http' },
      iproyal: { host: 'geo.iproyal.com', port: '12321', protocol: 'http' },
      oxylabs: { host: 'pr.oxylabs.io', port: '7777', protocol: 'http' },
    };
    const d = defaults[p];
    if (d) {
      setProtocol(d.protocol);
      setHost(d.host);
      setPort(d.port);
    }
  };

  const testProxy = async () => {
    if (!host || !port || !window.electronAPI?.proxy?.test) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.proxy.test({
        type: protocol,
        host,
        port: parseInt(port),
        username: login || undefined,
        password: password || undefined,
      });
      setTestResult(result ? 'success' : 'error');
    } catch {
      setTestResult('error');
    } finally {
      setTesting(false);
    }
  };

  const modes: { id: ProxyMode; label: string }[] = [
    { id: 'custom', label: 'Custom' },
    { id: 'saved', label: 'Saved Proxies' },
    { id: 'provider', label: 'Proxy Provider' },
  ];

  const protocols: { id: ProxyProtocol; label: string }[] = [
    { id: 'none', label: 'No Proxy (Local network)' },
    { id: 'http', label: 'HTTP' },
    { id: 'https', label: 'HTTPS' },
    { id: 'socks4', label: 'SOCKS4' },
    { id: 'socks5', label: 'SOCKS5' },
  ];

  const providers: { id: string; name: string; desc: string }[] = [
    { id: 'brightdata', name: 'Bright Data', desc: '72M+ residential IPs' },
    { id: 'smartproxy', name: 'Smartproxy', desc: '55M+ mobile & residential IPs' },
    { id: 'iproyal', name: 'IPRoyal', desc: 'Budget-friendly residential' },
    { id: 'oxylabs', name: 'Oxylabs', desc: 'Premium datacenter & residential' },
  ];

  return (
    <div className="space-y-5">
      {/* Section: Proxy */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
          Proxy
        </div>

        {/* Mode toggle buttons */}
        <div className="flex items-center gap-0 mb-4">
          {modes.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className="px-4 py-2 text-[13px] font-medium transition-all first:rounded-l-lg last:rounded-r-lg"
              style={{
                background: mode === m.id ? 'var(--accent)' : 'var(--bg-elevated)',
                color: mode === m.id ? '#fff' : 'var(--text-secondary)',
                border: mode === m.id ? '1px solid var(--accent)' : '1px solid var(--border-default)',
                marginLeft: m.id !== 'custom' ? '-1px' : '0',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Saved Proxies mode: dropdown */}
        {mode === 'saved' && (
          <div className="mb-4">
            <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Select from saved proxies</label>
            {savedProxies.length === 0 ? (
              <p className="text-[12px] py-3 px-3 rounded-lg" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                No saved proxies. Add proxies in the Proxy Manager page first.
              </p>
            ) : (
              <select
                value={selectedSavedId}
                onChange={e => handleSelectSaved(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                style={inputStyle}
              >
                <option value="">Select a proxy...</option>
                {savedProxies.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.type}://{p.host}:{p.port} {p.provider && p.provider !== 'custom' ? `(${p.provider})` : ''} {p.isHealthy === true ? '✓' : p.isHealthy === false ? '✗' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Provider mode: provider selector */}
        {mode === 'provider' && (
          <div className="mb-4">
            <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Provider</label>
            <div className="grid grid-cols-2 gap-2">
              {providers.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleProviderChange(p.id)}
                  className="p-2.5 rounded-lg text-left transition-all"
                  style={{
                    background: provider === p.id ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                    border: `1px solid ${provider === p.id ? 'var(--accent)' : 'var(--border-default)'}`,
                  }}
                >
                  <div className="text-[12px] font-medium" style={{ color: provider === p.id ? 'var(--accent-light)' : 'var(--text-primary)' }}>{p.name}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{p.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Proxy type + Check the network */}
        <div className="flex items-end gap-3 mb-4">
          <div className="flex-1">
            <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Proxy type</label>
            <select
              value={protocol}
              onChange={e => setProtocol(e.target.value as ProxyProtocol)}
              className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
              style={inputStyle}
            >
              {protocols.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={testProxy}
            disabled={protocol === 'none' || !host || !port || testing}
            className="px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all whitespace-nowrap flex items-center gap-2"
            style={{
              background: (protocol === 'none' || !host || !port || testing) ? 'var(--bg-elevated)' : 'var(--bg-overlay)',
              border: '1px solid var(--border-default)',
              color: (protocol === 'none' || !host || !port || testing) ? 'var(--text-muted)' : 'var(--text-primary)',
              cursor: (protocol === 'none' || !host || !port || testing) ? 'not-allowed' : 'pointer',
            }}
          >
            {testing ? <Loader size={14} className="animate-spin" /> : null}
            {testing ? 'Checking...' : 'Check the network'}
          </button>
        </div>

        {/* Test result */}
        {testResult && (
          <div className="mb-4 flex items-center gap-2 text-[12px] px-3 py-2 rounded-lg"
            style={{
              background: testResult === 'success' ? 'var(--success-subtle)' : 'var(--danger-subtle)',
              color: testResult === 'success' ? 'var(--success)' : 'var(--danger)',
            }}>
            {testResult === 'success' ? <><CheckCircle size={14} /> Proxy is working — connection successful</> : <><XCircle size={14} /> Connection failed — check your proxy settings</>}
          </div>
        )}

        {/* Host + Port */}
        {protocol !== 'none' && (
          <>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="col-span-2">
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Host</label>
                <input
                  type="text"
                  value={host}
                  onChange={e => { setHost(e.target.value); setTestResult(null); }}
                  className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  style={inputStyle}
                  placeholder="proxy.example.com"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Port</label>
                <input
                  type="text"
                  value={port}
                  onChange={e => { setPort(e.target.value.replace(/\D/g, '')); setTestResult(null); }}
                  className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  style={inputStyle}
                  placeholder="8080"
                />
              </div>
            </div>

            {/* Login + Password */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Login</label>
                <input
                  type="text"
                  value={login}
                  onChange={e => setLogin(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  style={inputStyle}
                  placeholder="username"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full px-3 py-2.5 pr-10 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    style={inputStyle}
                    placeholder="password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* IP checker */}
        <div>
          <label className="block text-[12px] font-medium mb-1.5" style={labelStyle}>IP checker</label>
          <select
            className="w-full px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
            style={inputStyle}
            defaultValue="ip2location"
          >
            <option value="ip2location">IP2Location</option>
            <option value="ipinfo">ipinfo.io</option>
            <option value="ipapi">ip-api.com</option>
          </select>
        </div>
      </div>
    </div>
  );
};

export default ConnectionSelector;
