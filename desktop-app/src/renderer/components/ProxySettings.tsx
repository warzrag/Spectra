import React, { useState, useEffect } from 'react';
import { Globe, Shield, CheckCircle, XCircle, Loader } from 'lucide-react';

interface ProxySettingsProps {
  value?: { type: string; host: string; port: number; username?: string; password?: string; provider?: string; };
  onChange: (proxy: any) => void;
  onTest?: () => Promise<boolean>;
}

const ProxySettings: React.FC<ProxySettingsProps> = ({ value, onChange, onTest }) => {
  const [proxyType, setProxyType] = useState(value?.type || 'http');
  const [proxyString, setProxyString] = useState('');
  const [provider, setProvider] = useState(value?.provider || 'custom');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);

  const providers: Record<string, { name: string; placeholder: string; format: string; desc: string }> = {
    brightdata: { name: 'Bright Data', placeholder: 'user-session-xxx:pass@proxy.brightdata.com:24000', format: 'http://user-session-xxx:pass@proxy.brightdata.com:24000', desc: '7M+ residential IPs' },
    smartproxy: { name: 'Smartproxy', placeholder: 'user_session-xxx:pass@gate.smartproxy.com:10000', format: 'http://user_session-xxx:pass@gate.smartproxy.com:10000', desc: '5M+ mobile IPs' },
    iproyal: { name: 'IPRoyal', placeholder: 'user_lifetime-300:pass@geo.iproyal.com:12321', format: 'http://user_lifetime-300:pass@geo.iproyal.com:12321', desc: 'Budget-friendly' },
    oxylabs: { name: 'Oxylabs', placeholder: 'customer-user:pass@pr.oxylabs.io:7777', format: 'http://customer-user:pass@pr.oxylabs.io:7777', desc: 'Premium residential' },
    custom: { name: 'Custom', placeholder: 'http://user:pass@proxy:8080', format: 'protocol://user:pass@host:port', desc: 'Your own proxy' },
  };

  useEffect(() => {
    if (value) {
      setProxyString(`${value.type}://${value.username}:${value.password}@${value.host}:${value.port}`);
    }
  }, [value]);

  const parseProxy = (str: string) => {
    try {
      str = str.trim();
      const urlMatch = str.match(/^(https?|socks5):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/i);
      if (urlMatch) return { type: urlMatch[1].toLowerCase(), username: urlMatch[2] || '', password: urlMatch[3] || '', host: urlMatch[4], port: parseInt(urlMatch[5]) };
      const parts = str.split(':');
      if (parts.length >= 2) return { type: proxyType, host: parts[0], port: parseInt(parts[1]), username: parts[2] || '', password: parts[3] || '' };
      return null;
    } catch { return null; }
  };

  const handleProxyChange = (val: string) => {
    setProxyString(val);
    if (!val) { onChange(null); return; }
    const parsed = parseProxy(val);
    if (parsed) onChange({ ...parsed, provider });
  };

  const testProxy = async () => {
    if (!proxyString || !onTest) return;
    setTesting(true); setTestResult(null);
    try { setTestResult((await onTest()) ? 'success' : 'error'); }
    catch { setTestResult('error'); }
    finally { setTesting(false); }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Provider</label>
        <select value={provider} onChange={e => { setProvider(e.target.value); if (e.target.value !== 'custom' && !proxyString) setProxyString(providers[e.target.value].format); }}
          className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
          {Object.entries(providers).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
        </select>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{providers[provider]?.desc}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Protocol</label>
          <select value={proxyType} onChange={e => setProxyType(e.target.value)} disabled={provider !== 'custom'}
            className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </div>
        <div className="flex items-end">
          <button type="button" onClick={testProxy} disabled={!proxyString || testing}
            className="w-full px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-[13px] font-medium text-white transition-all"
            style={{ background: !proxyString || testing ? 'var(--bg-overlay)' : 'var(--accent)', color: !proxyString || testing ? 'var(--text-muted)' : '#fff', cursor: !proxyString || testing ? 'not-allowed' : 'pointer' }}>
            {testing ? <><Loader size={14} className="animate-spin" /> Testing...</> : <><Shield size={14} /> Test Proxy</>}
          </button>
        </div>
      </div>

      <div>
        <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Proxy URL</label>
        <input type="text" value={proxyString} onChange={e => handleProxyChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          placeholder={providers[provider]?.placeholder} />
        {testResult && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[12px]" style={{ color: testResult === 'success' ? 'var(--success)' : 'var(--danger)' }}>
            {testResult === 'success' ? <><CheckCircle size={13} /> Proxy working</> : <><XCircle size={13} /> Test failed</>}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProxySettings;
