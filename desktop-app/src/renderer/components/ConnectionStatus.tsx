import React, { useState, useEffect } from 'react';
import { Wifi, Smartphone, Globe, RefreshCw, CheckCircle, Info } from 'lucide-react';

interface ConnectionStatusProps {
  profileId?: string;
  connectionType?: string;
}

const ConnectionStatus: React.FC<ConnectionStatusProps> = ({ profileId, connectionType }) => {
  const [currentIP, setCurrentIP] = useState('');
  const [loading, setLoading] = useState(false);
  const [ipDetails, setIpDetails] = useState<any>(null);
  const [networkInfo, setNetworkInfo] = useState<any[]>([]);

  useEffect(() => { checkConnection(); }, []);

  const checkConnection = async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.network) {
        const ip = await window.electronAPI.network.getCurrentIP();
        setCurrentIP(ip);
        const connections = await window.electronAPI.network.getConnections();
        setNetworkInfo(connections);
        try {
          const res = await fetch(`https://ipapi.co/${ip}/json/`);
          if (res.ok) setIpDetails(await res.json());
        } catch {}
      }
    } catch (error) { console.error('Connection check failed:', error); }
    finally { setLoading(false); }
  };

  const icon = connectionType === 'iphone' ? <Smartphone size={16} style={{ color: '#60a5fa' }} />
    : connectionType === 'wifi' ? <Wifi size={16} style={{ color: '#34d399' }} />
    : <Globe size={16} style={{ color: 'var(--text-muted)' }} />;

  const typeName = connectionType === 'iphone' ? 'iPhone 4G' : connectionType === 'wifi' ? 'WiFi' : connectionType === 'proxy' ? 'Proxy' : 'System Default';

  return (
    <div className="rounded-lg p-3 space-y-2 text-[12px]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-secondary)' }}>{icon} Connection Status</span>
        <button onClick={checkConnection} disabled={loading} className="p-1 rounded transition-colors"
          style={{ color: 'var(--text-muted)' }}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Type:</span><span style={{ color: 'var(--text-primary)' }}>{typeName}</span></div>
      <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>IP:</span><span className="font-mono" style={{ color: 'var(--text-primary)' }}>{currentIP || '...'}</span></div>
      {ipDetails && (
        <>
          <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>Location:</span><span style={{ color: 'var(--text-primary)' }}>{ipDetails.city}, {ipDetails.country_name}</span></div>
          <div className="flex justify-between"><span style={{ color: 'var(--text-muted)' }}>ISP:</span><span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>{ipDetails.org || ipDetails.isp}</span></div>
        </>
      )}
      {connectionType === 'iphone' && (
        <div className="pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {networkInfo.some(c => c.type === 'mobile' || c.type === 'usb')
            ? <span className="flex items-center gap-1.5" style={{ color: 'var(--success)' }}><CheckCircle size={13} /> iPhone detected</span>
            : <span className="flex items-center gap-1.5" style={{ color: 'var(--warning)' }}><Info size={13} /> iPhone not detected</span>
          }
        </div>
      )}
    </div>
  );
};

export default ConnectionStatus;
