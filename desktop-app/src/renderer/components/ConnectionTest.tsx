import React, { useState } from 'react';
import { Wifi, Smartphone, Globe, Shield, CheckCircle, XCircle, AlertTriangle, Loader, X } from 'lucide-react';

interface ConnectionTestProps {
  connectionType: string;
  onClose: () => void;
}

const ConnectionTest: React.FC<ConnectionTestProps> = ({ connectionType, onClose }) => {
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<any>(null);

  const runTests = async () => {
    setTesting(true); setResults(null);
    try {
      const tests: any = { currentIP: null, location: null, isp: null, isMobile: false, activeInterfaces: [], isExpectedConnection: false };
      if (window.electronAPI?.network) {
        tests.currentIP = await window.electronAPI.network.getCurrentIP();
        tests.activeInterfaces = await window.electronAPI.network.getConnections();
        try {
          const res = await fetch(`https://ipapi.co/${tests.currentIP}/json/`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const data = await res.json();
            tests.location = `${data.city || 'Unknown'}, ${data.country_name || 'Unknown'}`;
            tests.isp = data.org || data.isp || 'Unknown';
            tests.isMobile = ['mobile', 'cellular', 'wireless', '4g', 'lte', '5g'].some(k => tests.isp.toLowerCase().includes(k));
          }
        } catch { tests.location = 'Unknown'; tests.isp = 'Unable to detect'; }
        if (connectionType === 'iphone') tests.isExpectedConnection = tests.isMobile || tests.activeInterfaces.some((c: any) => c.type === 'mobile' || c.type === 'usb');
        else if (connectionType === 'wifi') tests.isExpectedConnection = !tests.isMobile && tests.activeInterfaces.some((c: any) => c.type === 'wifi');
      }
      setResults(tests);
    } catch { setResults({ error: 'Failed to run tests' }); }
    finally { setTesting(false); }
  };

  const icon = connectionType === 'iphone' ? <Smartphone size={18} style={{ color: '#60a5fa' }} />
    : connectionType === 'wifi' ? <Wifi size={18} style={{ color: '#34d399' }} />
    : connectionType === 'proxy' ? <Shield size={18} style={{ color: '#a78bfa' }} />
    : <Globe size={18} style={{ color: 'var(--text-muted)' }} />;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable">
      <div className="rounded-xl w-full max-w-md p-6 shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            {icon} Connection Test
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <X size={18} />
          </button>
        </div>

        {!results && !testing && (
          <div className="text-center py-8">
            <p className="text-[13px] mb-4" style={{ color: 'var(--text-muted)' }}>Verify your {connectionType === 'iphone' ? 'iPhone 4G' : connectionType} connection</p>
            <button onClick={runTests} className="px-5 py-2 rounded-lg text-[13px] font-medium text-white" style={{ background: 'var(--accent)' }}>Run Test</button>
          </div>
        )}

        {testing && (
          <div className="text-center py-8">
            <Loader className="animate-spin mx-auto mb-3" size={28} style={{ color: 'var(--accent)' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Testing connection...</p>
          </div>
        )}

        {results && !results.error && (
          <div className="space-y-3">
            {['IP Address', 'Location', 'ISP', 'Type'].map((label, i) => (
              <div key={label} className="flex justify-between py-1.5 text-[13px]" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                <span className={i === 0 ? 'font-mono' : ''} style={{ color: 'var(--text-primary)' }}>
                  {[results.currentIP, results.location, results.isp, results.isMobile ? 'Mobile/4G' : 'Broadband'][i]}
                </span>
              </div>
            ))}
            <div className="p-3 rounded-lg" style={{ background: results.isExpectedConnection ? 'var(--success-subtle)' : 'var(--warning-subtle)', border: `1px solid ${results.isExpectedConnection ? 'var(--success)' : 'var(--warning)'}` }}>
              <div className="flex items-center gap-2">
                {results.isExpectedConnection ? <CheckCircle size={18} style={{ color: 'var(--success)' }} /> : <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />}
                <div>
                  <p className="text-[13px] font-medium" style={{ color: results.isExpectedConnection ? 'var(--success)' : 'var(--warning)' }}>
                    {results.isExpectedConnection ? 'Verified' : 'Mismatch'}
                  </p>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {results.isExpectedConnection ? `Using ${connectionType === 'iphone' ? 'iPhone 4G' : connectionType}` : 'Connection does not match expected type'}
                  </p>
                </div>
              </div>
            </div>
            <button onClick={runTests} className="w-full py-2 rounded-lg text-[13px] font-medium" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>Test Again</button>
          </div>
        )}

        {results?.error && (
          <div className="text-center py-8">
            <XCircle size={28} className="mx-auto mb-3" style={{ color: 'var(--danger)' }} />
            <p className="text-[13px]" style={{ color: 'var(--danger)' }}>{results.error}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ConnectionTest;
