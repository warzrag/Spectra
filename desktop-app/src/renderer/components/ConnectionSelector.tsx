import React, { useState, useEffect } from 'react';
import { Wifi, Smartphone, Globe, Shield, Settings, AlertCircle, RefreshCw, CheckCircle } from 'lucide-react';
import ProxySettings from './ProxySettings';

interface ConnectionSelectorProps {
  value?: any;
  onChange: (value: any) => void;
}

type ConnectionType = 'system' | 'iphone' | 'wifi' | 'proxy';

const ConnectionSelector: React.FC<ConnectionSelectorProps> = ({ value, onChange }) => {
  const [connectionType, setConnectionType] = useState<ConnectionType>(value?.type || 'system');
  const [networks, setNetworks] = useState<any[]>([]);
  const [currentIP, setCurrentIP] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [proxyConfig, setProxyConfig] = useState(value?.proxy || null);

  useEffect(() => {
    if (connectionType === 'iphone' || connectionType === 'wifi') loadNetworks();
  }, [connectionType]);

  const loadNetworks = async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.network) {
        const [conns, ip] = await Promise.all([
          window.electronAPI.network.getConnections(),
          window.electronAPI.network.getCurrentIP(),
        ]);
        setNetworks(conns);
        setCurrentIP(ip);
      }
    } catch (error) {
      console.error('Failed to load networks:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTypeChange = (type: ConnectionType) => {
    setConnectionType(type);
    if (type === 'system') onChange({ type: 'system' });
    else if (type === 'proxy') onChange({ type: 'proxy', proxy: proxyConfig });
  };

  const options = [
    { id: 'system', name: 'System Default', desc: 'Default connection', icon: <Globe size={18} style={{ color: 'var(--text-muted)' }} /> },
    { id: 'iphone', name: 'iPhone 4G', desc: 'Mobile hotspot', icon: <Smartphone size={18} style={{ color: '#60a5fa' }} /> },
    { id: 'wifi', name: 'Home WiFi', desc: 'WiFi connection', icon: <Wifi size={18} style={{ color: '#34d399' }} /> },
    { id: 'proxy', name: 'Proxy', desc: 'Proxy server', icon: <Shield size={18} style={{ color: '#a78bfa' }} /> },
  ];

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        <Settings size={14} /> Connection Type
      </label>

      <div className="grid grid-cols-4 gap-2">
        {options.map(opt => (
          <button key={opt.id} type="button" onClick={() => handleTypeChange(opt.id as ConnectionType)}
            className="p-3 rounded-lg text-left transition-all"
            style={{
              background: connectionType === opt.id ? 'var(--accent-subtle, rgba(99,102,241,0.1))' : 'var(--bg-elevated)',
              border: connectionType === opt.id ? '1px solid var(--accent)' : '1px solid var(--border-default)',
            }}>
            <div className="mb-1.5">{opt.icon}</div>
            <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{opt.name}</div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{opt.desc}</div>
          </button>
        ))}
      </div>

      {connectionType === 'iphone' && (
        <div className="rounded-lg p-3 text-[12px] space-y-2" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>Connect iPhone via USB or WiFi Hotspot</p>
          {loading && <div className="flex items-center gap-2" style={{ color: 'var(--text-muted)' }}><RefreshCw size={12} className="animate-spin" />Detecting...</div>}
          {!loading && networks.filter(n => n.type === 'mobile' || n.type === 'usb').length > 0 && (
            <div className="flex items-center gap-2" style={{ color: 'var(--success)' }}><CheckCircle size={13} /> iPhone detected - IP: {currentIP}</div>
          )}
          <p className="flex items-start gap-1.5" style={{ color: '#60a5fa' }}>
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            Toggle Airplane Mode for a new IP.
          </p>
        </div>
      )}

      {connectionType === 'wifi' && (
        <div className="rounded-lg p-3 text-[12px]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Using home WiFi. All instances share the same IP.</p>
          {currentIP && <p className="mt-1"><span style={{ color: 'var(--text-muted)' }}>IP:</span> <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{currentIP}</span></p>}
        </div>
      )}

      {connectionType === 'proxy' && (
        <ProxySettings value={proxyConfig} onChange={(p) => { setProxyConfig(p); onChange({ type: 'proxy', proxy: p }); }}
          onTest={async () => { if (window.electronAPI?.proxy) return await window.electronAPI.proxy.test(proxyConfig); return false; }} />
      )}

      {connectionType === 'system' && currentIP && (
        <div className="rounded-lg p-3 text-[12px]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <p style={{ color: 'var(--text-muted)' }}>System default connection. No special routing.</p>
        </div>
      )}
    </div>
  );
};

export default ConnectionSelector;
