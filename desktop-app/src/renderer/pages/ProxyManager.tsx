import React, { useState, useEffect } from 'react';
import { Plus, Trash2, RefreshCw, CheckCircle, XCircle, Upload, Download, Shield, Globe, X } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';

interface Proxy {
  id: string;
  name?: string;
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  provider?: string;
  country?: string;
  isHealthy?: boolean;
  lastCheck?: string;
}

const ProxyManagerPage: React.FC = () => {
  const { showToast } = useToast();
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [bulkProxies, setBulkProxies] = useState('');
  const [testingProxies, setTestingProxies] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProxies();
  }, []);

  const loadProxies = async () => {
    try {
      const allProxies = await window.electronAPI.proxy.getAll();
      setProxies(allProxies);
    } catch (error) {
      console.error('Failed to load proxies:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddBulkProxies = async () => {
    if (!bulkProxies.trim()) return;
    try {
      const count = await window.electronAPI.proxy.addBulk(bulkProxies);
      showToast(`Added ${count} proxies successfully`, 'success');
      setBulkProxies('');
      setShowAddModal(false);
      loadProxies();
    } catch (error) {
      console.error('Failed to add proxies:', error);
      showToast('Failed to add proxies', 'error');
    }
  };

  const testProxy = async (proxyId: string) => {
    setTestingProxies(prev => new Set(prev).add(proxyId));
    try {
      const proxy = proxies.find(p => p.id === proxyId);
      if (proxy) {
        const isHealthy = await window.electronAPI.proxy.test(proxy);
        setProxies(prev => prev.map(p =>
          p.id === proxyId ? { ...p, isHealthy, lastCheck: new Date().toISOString() } : p
        ));
      }
    } finally {
      setTestingProxies(prev => {
        const next = new Set(prev);
        next.delete(proxyId);
        return next;
      });
    }
  };

  const testAllProxies = async () => {
    await window.electronAPI.proxy.healthCheck();
    loadProxies();
  };

  const removeProxy = async (proxyId: string) => {
    if (!confirm('Are you sure you want to remove this proxy?')) return;
    try {
      await window.electronAPI.proxy.remove(proxyId);
      setProxies(prev => prev.filter(p => p.id !== proxyId));
    } catch (error) {
      console.error('Failed to remove proxy:', error);
    }
  };

  const exportProxies = () => {
    const proxyStrings = proxies.map(p => {
      const auth = p.username && p.password ? `${p.username}:${p.password}@` : '';
      return `${p.type}://${auth}${p.host}:${p.port}`;
    }).join('\n');
    const blob = new Blob([proxyStrings], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'proxies.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatProxy = (proxy: Proxy) => {
    const auth = proxy.username && proxy.password ? `${proxy.username}:****@` : '';
    return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
  };

  const healthyCount = proxies.filter(p => p.isHealthy).length;
  const failedCount = proxies.filter(p => p.isHealthy === false).length;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Globe size={20} style={{ color: 'var(--accent)' }} />
            Proxy Manager
          </h1>
          <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Manage your proxy connections</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportProxies}
            disabled={proxies.length === 0}
            className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors disabled:opacity-40"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
          >
            <Download size={14} /> Export
          </button>
          <button
            onClick={testAllProxies}
            className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium text-white transition-all"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #6366f1)' }}
          >
            <RefreshCw size={14} /> Test All
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium text-white transition-all"
            style={{ background: 'var(--accent)' }}
          >
            <Plus size={14} /> Add Proxies
          </button>
        </div>
      </header>

      {/* Stats */}
      <div className="px-5 py-3 flex gap-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Total:</span>
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{proxies.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} />
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Healthy:</span>
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--success)' }}>{healthyCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--danger)' }} />
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Failed:</span>
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--danger)' }}>{failedCount}</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading proxies...</div>
          </div>
        ) : proxies.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
              <Globe size={28} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div className="text-center">
              <p className="text-[14px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>No proxies added</p>
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Add proxies to start using them with your instances</p>
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 rounded-lg flex items-center gap-2 text-[13px] font-medium text-white"
              style={{ background: 'var(--accent)' }}
            >
              <Plus size={16} /> Add Proxies
            </button>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Proxy</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Provider</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Type</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Status</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Last Check</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((proxy) => (
                <tr key={proxy.id} className="group transition-colors" style={{ borderBottom: '1px solid var(--border-subtle)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td className="px-4 py-2.5">
                    <div className="text-[13px] font-mono" style={{ color: 'var(--text-primary)' }}>{formatProxy(proxy)}</div>
                    {proxy.name && <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{proxy.name}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{proxy.provider || 'Custom'}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-[12px] uppercase font-medium px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>{proxy.type}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    {proxy.isHealthy === true && (
                      <span className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--success)' }}>
                        <CheckCircle size={14} /> Healthy
                      </span>
                    )}
                    {proxy.isHealthy === false && (
                      <span className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--danger)' }}>
                        <XCircle size={14} /> Failed
                      </span>
                    )}
                    {proxy.isHealthy === undefined && (
                      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Not tested</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {proxy.lastCheck ? new Date(proxy.lastCheck).toLocaleString() : 'Never'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => testProxy(proxy.id)}
                        disabled={testingProxies.has(proxy.id)}
                        className="p-1.5 rounded-md transition-colors disabled:opacity-40"
                        style={{ color: 'var(--text-muted)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        title="Test proxy"
                      >
                        {testingProxies.has(proxy.id) ? <RefreshCw size={14} className="animate-spin" /> : <Shield size={14} />}
                      </button>
                      <button
                        onClick={() => removeProxy(proxy.id)}
                        className="p-1.5 rounded-md transition-colors"
                        style={{ color: 'var(--danger)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        title="Remove proxy"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Proxies Modal */}
      {showAddModal && (
        <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable" onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false); }}>
          <div className="rounded-xl w-full max-w-2xl overflow-hidden shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }} onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Add Proxies</h2>
              <button onClick={() => setShowAddModal(false)} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <X size={18} />
              </button>
            </div>

            <div className="p-6">
              <div className="mb-4">
                <p className="text-[13px] mb-2" style={{ color: 'var(--text-secondary)' }}>Enter proxies in one of the following formats:</p>
                <div className="text-[12px] font-mono space-y-0.5 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                  <div>protocol://username:password@host:port</div>
                  <div>protocol://host:port</div>
                  <div>host:port:username:password</div>
                  <div>host:port</div>
                </div>
              </div>
              <textarea
                value={bulkProxies}
                onChange={(e) => setBulkProxies(e.target.value)}
                placeholder="Enter proxies, one per line..."
                className="w-full h-56 px-3 py-2 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
            </div>

            <div className="px-6 py-4 flex justify-end gap-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => { setShowAddModal(false); setBulkProxies(''); }}
                className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>
                Cancel
              </button>
              <button onClick={handleAddBulkProxies}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-all flex items-center gap-2"
                style={{ background: 'var(--accent)' }}>
                <Upload size={14} /> Add Proxies
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProxyManagerPage;
