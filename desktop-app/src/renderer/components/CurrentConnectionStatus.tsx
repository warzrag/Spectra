import React, { useState, useEffect } from 'react';
import { Globe, RefreshCw } from 'lucide-react';

const CurrentConnectionStatus: React.FC = () => {
  const [currentIP, setCurrentIP] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkConnection();
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, []);

  const checkConnection = async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.network) {
        const ip = await window.electronAPI.network.getCurrentIP();
        setCurrentIP(ip);
      }
    } catch {} finally { setLoading(false); }
  };

  return (
    <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
      <Globe size={13} />
      <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{currentIP || '...'}</span>
      <button onClick={checkConnection} disabled={loading} className="p-0.5 rounded">
        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
};

export default CurrentConnectionStatus;
