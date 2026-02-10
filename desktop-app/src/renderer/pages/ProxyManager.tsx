import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, RefreshCw, CheckCircle, XCircle, Download, Shield, Globe, X, Shuffle, Search, Copy, AlertCircle, Zap, Clock, Filter, ChevronDown, Link2, Unlink, FolderOpen } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { Profile, Folder } from '../../types';
import {
  subscribeToProxies,
  createProxy as firestoreCreateProxy,
  createProxiesBulk,
  updateProxy as firestoreUpdateProxy,
  deleteProxy as firestoreDeleteProxy,
  deleteProxiesBulk,
  FirestoreProxy,
} from '../services/firestore-service';

type Proxy = FirestoreProxy;

interface ProxyManagerPageProps {
  profiles?: Profile[];
  folders?: Folder[];
  onUpdateProfile?: (profileId: string, data: any) => Promise<void>;
  userId?: string;
  teamId?: string;
}

type StatusFilter = 'all' | 'healthy' | 'failed' | 'untested';
type TypeFilter = 'all' | 'http' | 'https' | 'socks4' | 'socks5';

// Country flag image component
function CountryFlag({ code }: { code: string }) {
  return (
    <img
      src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`}
      alt={code}
      title={code}
      width={16}
      height={12}
      style={{ display: 'inline-block', borderRadius: 2, verticalAlign: 'middle' }}
      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

const ProxyManagerPage: React.FC<ProxyManagerPageProps> = ({ profiles = [], folders = [], onUpdateProfile, userId, teamId }) => {
  const { showToast } = useToast();
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [bulkProxies, setBulkProxies] = useState('');
  const [testingProxies, setTestingProxies] = useState(new Set<string>());
  const [testingAll, setTestingAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProxies, setSelectedProxies] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [assignDropdownProxy, setAssignDropdownProxy] = useState<string | null>(null);
  const assignDropdownRef = useRef<HTMLDivElement>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [addProxyFolderId, setAddProxyFolderId] = useState<string>('');
  const [folderDropdownProxy, setFolderDropdownProxy] = useState<string | null>(null);
  const folderDropdownRef = useRef<HTMLDivElement>(null);

  // Subscribe to Firestore proxies (real-time sync, scoped by teamId)
  useEffect(() => {
    if (!teamId) return;
    const unsub = subscribeToProxies(teamId, (allProxies) => {
      setProxies(allProxies);
      setLoading(false);
    });
    return () => unsub();
  }, [teamId]);

  // Close assign dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (assignDropdownRef.current && !assignDropdownRef.current.contains(e.target as Node)) {
        setAssignDropdownProxy(null);
      }
    };
    if (assignDropdownProxy) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [assignDropdownProxy]);

  // Close folder dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (folderDropdownRef.current && !folderDropdownRef.current.contains(e.target as Node)) {
        setFolderDropdownProxy(null);
      }
    };
    if (folderDropdownProxy) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [folderDropdownProxy]);

  // Parse proxy string in various formats
  const parseProxyString = (proxyStr: string): Omit<Proxy, 'id'> | null => {
    // Format: protocol://username:password@host:port
    const regex = /^(https?|socks[45]):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/i;
    const match = proxyStr.match(regex);
    if (match) {
      return {
        type: match[1].toLowerCase(),
        username: match[2] || undefined,
        password: match[3] || undefined,
        host: match[4],
        port: parseInt(match[5], 10),
      };
    }
    // Alternative format: host:port:username:password
    const parts = proxyStr.split(':');
    if (parts.length >= 2 && parseInt(parts[1], 10) > 0) {
      return {
        type: 'http',
        host: parts[0],
        port: parseInt(parts[1], 10),
        username: parts[2] || undefined,
        password: parts[3] || undefined,
      };
    }
    return null;
  };

  const handleAddBulkProxies = async () => {
    if (!bulkProxies.trim()) return;
    setAdding(true);
    try {
      const lines = bulkProxies.split('\n').filter(l => l.trim());
      const parsed: Omit<Proxy, 'id'>[] = [];
      let failed = 0;
      for (const line of lines) {
        const proxy = parseProxyString(line.trim());
        if (proxy) {
          parsed.push(proxy);
        } else {
          failed++;
        }
      }
      if (parsed.length > 0) {
        // Clean undefined values (Firestore doesn't accept undefined)
        const cleaned = parsed.map(p => {
          const clean: any = { type: p.type, host: p.host, port: p.port };
          if (p.username) clean.username = p.username;
          if (p.password) clean.password = p.password;
          if (addProxyFolderId) clean.folderId = addProxyFolderId;
          return clean;
        });
        await createProxiesBulk(cleaned, userId || 'unknown', teamId || '');
      }
      if (failed > 0) {
        showToast(`Added ${parsed.length} proxies, ${failed} failed (invalid format)`, parsed.length > 0 ? 'success' : 'error');
      } else {
        showToast(`Added ${parsed.length} proxies successfully`, 'success');
      }
      setBulkProxies('');
      setAddProxyFolderId('');
      setShowAddModal(false);
    } catch (error) {
      console.error('Failed to add proxies:', error);
      showToast('Failed to add proxies', 'error');
    } finally {
      setAdding(false);
    }
  };

  const testProxy = async (proxyId: string) => {
    setTestingProxies(prev => new Set(prev).add(proxyId));
    try {
      const proxy = proxies.find(p => p.id === proxyId);
      if (proxy) {
        const start = Date.now();
        const result = await window.electronAPI.proxy.test(proxy);
        const responseTime = Date.now() - start;
        const res = result as any;
        const isHealthy = res && typeof res === 'object' ? res.isHealthy : res;
        const country = res && typeof res === 'object' ? res.country : undefined;
        const lastCheck = new Date().toISOString();
        // Save test results to Firestore
        const updateData: any = { isHealthy, lastCheck, responseTime };
        if (country) updateData.country = country;
        await firestoreUpdateProxy(proxyId, updateData).catch(() => {});
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
    setTestingAll(true);
    try {
      for (const proxy of proxies) {
        setTestingProxies(prev => new Set(prev).add(proxy.id));
        try {
          const start = Date.now();
          const result = await window.electronAPI.proxy.test(proxy);
          const responseTime = Date.now() - start;
          const res = result as any;
          const isHealthy = res && typeof res === 'object' ? res.isHealthy : res;
          const country = res && typeof res === 'object' ? res.country : undefined;
          const lastCheck = new Date().toISOString();
          const updateData: any = { isHealthy, lastCheck, responseTime };
          if (country) updateData.country = country;
          await firestoreUpdateProxy(proxy.id, updateData).catch(() => {});
        } finally {
          setTestingProxies(prev => {
            const next = new Set(prev);
            next.delete(proxy.id);
            return next;
          });
        }
      }
      showToast(`Tested ${proxies.length} proxies`, 'success');
    } finally {
      setTestingAll(false);
    }
  };

  const testSelected = async () => {
    const selected = Array.from(selectedProxies);
    for (const id of selected) {
      await testProxy(id);
    }
    showToast(`Tested ${selected.length} proxies`, 'success');
  };

  const removeProxy = async (proxyId: string) => {
    try {
      await firestoreDeleteProxy(proxyId);
      setSelectedProxies(prev => {
        const next = new Set(prev);
        next.delete(proxyId);
        return next;
      });
    } catch (error) {
      console.error('Failed to remove proxy:', error);
    }
  };

  const removeSelected = async () => {
    const count = selectedProxies.size;
    if (!confirm(`Remove ${count} proxies?`)) return;
    const ids = Array.from(selectedProxies);
    await deleteProxiesBulk(ids);
    setSelectedProxies(new Set());
    showToast(`Removed ${count} proxies`, 'success');
  };

  // Assign a specific proxy to a specific profile
  const handleAssignToProfile = async (proxy: Proxy, profileId: string) => {
    if (!onUpdateProfile) return;
    try {
      const proxyData = { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password };
      await onUpdateProfile(profileId, {
        proxy: proxyData,
        connectionType: 'proxy',
        connectionConfig: { type: 'proxy', proxy: proxyData },
      });
      showToast(`Proxy assigned to profile`, 'success');
      setAssignDropdownProxy(null);
    } catch (error) {
      console.error('Assign failed:', error);
      showToast('Failed to assign proxy', 'error');
    }
  };

  // Unassign proxy from a profile
  const handleUnassignProfile = async (profileId: string) => {
    if (!onUpdateProfile) return;
    try {
      await onUpdateProfile(profileId, {
        proxy: null,
        connectionType: 'system',
        connectionConfig: { type: 'system' },
      });
      showToast('Proxy removed from profile', 'success');
    } catch (error) {
      console.error('Unassign failed:', error);
    }
  };

  // Change folder for a proxy
  const handleChangeFolder = async (proxyId: string, folderId: string | null) => {
    try {
      await firestoreUpdateProxy(proxyId, { folderId });
      setFolderDropdownProxy(null);
    } catch {
      showToast('Failed to update folder', 'error');
    }
  };

  // Auto-assign: 1 unique proxy per unassigned profile (folder-aware)
  const handleAutoAssign = async () => {
    if (!onUpdateProfile) return;

    // Scope proxies and profiles based on folder filter (including children)
    const folderChildIds = folderFilter && folderFilter !== 'none'
      ? folders.filter(f => f.parentId === folderFilter).map(f => f.id)
      : [];
    const matchesFolderScope = (folderId: string | undefined | null) => {
      if (!folderFilter) return true;
      if (folderFilter === 'none') return !folderId;
      return folderId === folderFilter || folderChildIds.includes(folderId || '');
    };
    const scopedProxies = proxies.filter(px => matchesFolderScope(px.folderId));
    const scopedProfiles = profiles.filter(p => matchesFolderScope(p.folderId));

    if (scopedProxies.length === 0) {
      showToast('No proxies available' + (folderFilter ? ' in this folder' : ''), 'error');
      return;
    }
    const unassigned = scopedProfiles.filter(p => !p.proxy || !(p.proxy as any).host);
    if (unassigned.length === 0) {
      showToast('All profiles already have a proxy' + (folderFilter ? ' in this folder' : ''), 'info');
      return;
    }

    // Find which proxies are already used (by host:port) in the SAME folder scope
    const usedKeys = new Set<string>();
    for (const p of scopedProfiles) {
      if (p.proxy && (p.proxy as any).host) {
        usedKeys.add(`${(p.proxy as any).host}:${(p.proxy as any).port}`);
      }
    }

    // Get available proxies (not used by profiles in this folder scope)
    const available = scopedProxies.filter(px => !usedKeys.has(`${px.host}:${px.port}`));
    if (available.length === 0) {
      showToast('No free proxies available' + (folderFilter ? ' in this folder' : ''), 'error');
      return;
    }

    let assigned = 0;
    for (let i = 0; i < unassigned.length && i < available.length; i++) {
      const proxy = available[i];
      const proxyData = { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password };
      try {
        await onUpdateProfile(unassigned[i].id, {
          proxy: proxyData,
          connectionType: 'proxy',
          connectionConfig: { type: 'proxy', proxy: proxyData },
        });
        assigned++;
      } catch {}
    }
    showToast(`${assigned} proxies assigned to profiles`, 'success');
  };

  const exportProxies = () => {
    const list = selectedProxies.size > 0
      ? proxies.filter(p => selectedProxies.has(p.id))
      : proxies;
    const proxyStrings = list.map(p => {
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

  const copyProxy = (proxy: Proxy) => {
    const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
    const str = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
    navigator.clipboard.writeText(str);
    showToast('Proxy copied to clipboard', 'success');
  };

  const toggleSelect = (id: string) => {
    setSelectedProxies(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedProxies.size === filteredProxies.length) {
      setSelectedProxies(new Set());
    } else {
      setSelectedProxies(new Set(filteredProxies.map(p => p.id)));
    }
  };

  const formatRelativeTime = (dateStr?: string) => {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  const getSpeedColor = (ms?: number) => {
    if (!ms) return 'var(--text-muted)';
    if (ms < 500) return 'var(--success)';
    if (ms < 1500) return '#f59e0b';
    return 'var(--danger)';
  };

  const getSpeedLabel = (ms?: number) => {
    if (!ms) return '-';
    if (ms < 500) return 'Fast';
    if (ms < 1500) return 'Medium';
    return 'Slow';
  };

  // Bulk line count for add modal
  const lineCount = bulkProxies.trim() ? bulkProxies.trim().split('\n').filter(l => l.trim()).length : 0;

  // Stats
  const healthyCount = proxies.filter(p => p.isHealthy === true).length;
  const failedCount = proxies.filter(p => p.isHealthy === false).length;
  const untestedCount = proxies.filter(p => p.isHealthy === undefined || p.isHealthy === null).length;
  const avgSpeed = (() => {
    const withTime = proxies.filter(p => p.responseTime);
    if (withTime.length === 0) return 0;
    return Math.round(withTime.reduce((sum, p) => sum + (p.responseTime || 0), 0) / withTime.length);
  })();

  // Filtering
  const filteredProxies = proxies.filter(p => {
    const matchesSearch = !searchTerm ||
      p.host.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.provider || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.country || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.name || '').toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' ||
      (statusFilter === 'healthy' && p.isHealthy === true) ||
      (statusFilter === 'failed' && p.isHealthy === false) ||
      (statusFilter === 'untested' && (p.isHealthy === undefined || p.isHealthy === null));

    const matchesType = typeFilter === 'all' || p.type === typeFilter;

    const matchesFolder = folderFilter === null ||
      (folderFilter === 'none' ? !p.folderId : (() => {
        if (p.folderId === folderFilter) return true;
        // Also match children of the selected folder
        const childIds = folders.filter(f => f.parentId === folderFilter).map(f => f.id);
        return childIds.includes(p.folderId || '');
      })());

    return matchesSearch && matchesStatus && matchesType && matchesFolder;
  });

  // Get profiles assigned to a specific proxy
  const getAssignedProfiles = (proxy: Proxy) => {
    return profiles.filter(p => p.proxy && (p.proxy as any).host === proxy.host && (p.proxy as any).port === proxy.port);
  };

  // Get profiles that don't have any proxy assigned
  const getUnassignedProfiles = () => {
    return profiles.filter(p => !p.proxy || !(p.proxy as any).host);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="px-6 py-4 flex items-center justify-between gap-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <h1 className="text-[18px] font-bold flex items-center gap-2.5" style={{ color: 'var(--text-primary)' }}>
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent-subtle)' }}>
              <Globe size={18} style={{ color: 'var(--accent-light)' }} />
            </div>
            Proxy Manager
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 rounded-lg flex items-center gap-2 text-[13px] font-semibold text-white transition-all"
            style={{ background: 'var(--accent)', boxShadow: '0 2px 8px rgba(99,102,241,0.3)' }}
          >
            <Plus size={15} /> Add Proxies
          </button>
        </div>
      </header>

      {/* Stats Cards */}
      <div className="px-6 py-4 grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="px-4 py-3 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-center gap-2 mb-1">
            <Globe size={14} style={{ color: 'var(--accent-light)' }} />
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Total</span>
          </div>
          <div className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{proxies.length}</div>
        </div>
        <div className="px-4 py-3 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle size={14} style={{ color: 'var(--success)' }} />
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Healthy</span>
          </div>
          <div className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--success)' }}>{healthyCount}</div>
        </div>
        <div className="px-4 py-3 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-center gap-2 mb-1">
            <XCircle size={14} style={{ color: 'var(--danger)' }} />
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Failed</span>
          </div>
          <div className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--danger)' }}>{failedCount}</div>
        </div>
        <div className="px-4 py-3 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle size={14} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Untested</span>
          </div>
          <div className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--text-muted)' }}>{untestedCount}</div>
        </div>
        <div className="px-4 py-3 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-center gap-2 mb-1">
            <Zap size={14} style={{ color: '#f59e0b' }} />
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Avg Speed</span>
          </div>
          <div className="text-[20px] font-bold tabular-nums" style={{ color: avgSpeed ? getSpeedColor(avgSpeed) : 'var(--text-muted)' }}>
            {avgSpeed ? `${avgSpeed}ms` : '-'}
          </div>
        </div>
      </div>

      {/* Toolbar: Search + Filters + Actions */}
      <div className="px-6 py-3 flex items-center gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Search proxies..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg text-[13px]"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          />
        </div>

        {/* Filter toggles */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="px-3 py-2 rounded-lg flex items-center gap-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: (statusFilter !== 'all' || typeFilter !== 'all') ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
              border: `1px solid ${(statusFilter !== 'all' || typeFilter !== 'all') ? 'var(--accent)' : 'var(--border-default)'}`,
              color: (statusFilter !== 'all' || typeFilter !== 'all') ? 'var(--accent-light)' : 'var(--text-secondary)',
            }}
          >
            <Filter size={13} /> Filters
            {(statusFilter !== 'all' || typeFilter !== 'all') && (
              <span className="w-4 h-4 rounded-full text-[10px] flex items-center justify-center text-white" style={{ background: 'var(--accent)' }}>
                {(statusFilter !== 'all' ? 1 : 0) + (typeFilter !== 'all' ? 1 : 0)}
              </span>
            )}
            <ChevronDown size={12} />
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bulk actions (when selected) */}
        {selectedProxies.size > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium" style={{ color: 'var(--accent-light)' }}>
              {selectedProxies.size} selected
            </span>
            <button
              onClick={testSelected}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium transition-colors"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              <Shield size={13} /> Test
            </button>
            <button
              onClick={exportProxies}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium transition-colors"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              <Download size={13} /> Export
            </button>
            <button
              onClick={removeSelected}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium transition-colors"
              style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
            >
              <Trash2 size={13} /> Remove
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={exportProxies}
              disabled={proxies.length === 0}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              <Download size={13} /> Export
            </button>
            <button
              onClick={handleAutoAssign}
              disabled={proxies.length === 0}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: '#f59e0b' }}
            >
              <Shuffle size={13} /> Auto-assign
            </button>
            <button
              onClick={testAllProxies}
              disabled={proxies.length === 0 || testingAll}
              className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium text-white transition-all disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #6366f1)' }}
            >
              <RefreshCw size={13} className={testingAll ? 'animate-spin' : ''} />
              {testingAll ? 'Testing...' : 'Test All'}
            </button>
          </div>
        )}
      </div>

      {/* Filter dropdown */}
      {showFilters && (
        <div className="px-6 py-3 flex items-center gap-4" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Status:</span>
            {(['all', 'healthy', 'failed', 'untested'] as StatusFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors capitalize"
                style={{
                  background: statusFilter === f ? 'var(--accent-subtle)' : 'transparent',
                  color: statusFilter === f ? 'var(--accent-light)' : 'var(--text-muted)',
                  border: statusFilter === f ? '1px solid var(--accent)' : '1px solid transparent',
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="w-px h-5" style={{ background: 'var(--border-default)' }} />
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Type:</span>
            {(['all', 'http', 'https', 'socks4', 'socks5'] as TypeFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors uppercase"
                style={{
                  background: typeFilter === f ? 'var(--accent-subtle)' : 'transparent',
                  color: typeFilter === f ? 'var(--accent-light)' : 'var(--text-muted)',
                  border: typeFilter === f ? '1px solid var(--accent)' : '1px solid transparent',
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {(statusFilter !== 'all' || typeFilter !== 'all') && (
            <button
              onClick={() => { setStatusFilter('all'); setTypeFilter('all'); }}
              className="text-[11px] font-medium transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Folder tabs (hierarchical) */}
      {folders.length > 0 && (() => {
        const rootFolders = folders.filter(f => !f.parentId);
        const getChildIds = (parentId: string) => folders.filter(f => f.parentId === parentId).map(f => f.id);
        const getProxyCount = (folderId: string) => {
          const childIds = getChildIds(folderId);
          return proxies.filter(p => p.folderId === folderId || childIds.includes(p.folderId || '')).length;
        };

        return (
          <div className="px-6 py-2 flex items-center gap-1.5 overflow-x-auto" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <button
              onClick={() => setFolderFilter(null)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap flex items-center gap-1.5"
              style={{
                background: folderFilter === null ? 'var(--accent-subtle)' : 'transparent',
                color: folderFilter === null ? 'var(--accent-light)' : 'var(--text-muted)',
                border: folderFilter === null ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              All
              <span className="text-[10px] opacity-70">{proxies.length}</span>
            </button>
            {rootFolders.map(f => {
              const children = folders.filter(c => c.parentId === f.id);
              const count = getProxyCount(f.id);
              const isActive = folderFilter === f.id || children.some(c => folderFilter === c.id);
              return (
                <React.Fragment key={f.id}>
                  <button
                    onClick={() => setFolderFilter(folderFilter === f.id ? null : f.id)}
                    className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap flex items-center gap-1.5"
                    style={{
                      background: isActive ? 'var(--accent-subtle)' : 'transparent',
                      color: isActive ? 'var(--accent-light)' : 'var(--text-muted)',
                      border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
                    }}
                  >
                    {f.icon && <span className="text-[13px]">{f.icon}</span>}
                    {f.name}
                    <span className="text-[10px] opacity-70">{count}</span>
                  </button>
                  {/* Show children when parent is active */}
                  {isActive && children.map(child => (
                    <button
                      key={child.id}
                      onClick={() => setFolderFilter(folderFilter === child.id ? f.id : child.id)}
                      className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap flex items-center gap-1"
                      style={{
                        background: folderFilter === child.id ? 'var(--accent)' : 'var(--bg-elevated)',
                        color: folderFilter === child.id ? '#fff' : 'var(--text-muted)',
                        border: '1px solid ' + (folderFilter === child.id ? 'var(--accent)' : 'var(--border-default)'),
                      }}
                    >
                      {child.icon && <span className="text-[11px]">{child.icon}</span>}
                      {child.name}
                      <span className="text-[10px] opacity-70">{proxies.filter(p => p.folderId === child.id).length}</span>
                    </button>
                  ))}
                </React.Fragment>
              );
            })}
            <button
              onClick={() => setFolderFilter(folderFilter === 'none' ? null : 'none')}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap flex items-center gap-1.5"
              style={{
                background: folderFilter === 'none' ? 'var(--bg-elevated)' : 'transparent',
                color: folderFilter === 'none' ? 'var(--text-secondary)' : 'var(--text-muted)',
                border: folderFilter === 'none' ? '1px solid var(--border-default)' : '1px solid transparent',
              }}
            >
              No Folder
              <span className="text-[10px] opacity-70">{proxies.filter(p => !p.folderId).length}</span>
            </button>
          </div>
        );
      })()}

      {/* Table */}
      <div className="flex-1 overflow-auto overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex items-center gap-2">
              <RefreshCw size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
              <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading proxies...</span>
            </div>
          </div>
        ) : proxies.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-5">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
              <Globe size={36} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div className="text-center">
              <p className="text-[15px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>No proxies yet</p>
              <p className="text-[13px] max-w-xs" style={{ color: 'var(--text-muted)' }}>
                Add proxies to protect your browser instances and manage connections efficiently.
              </p>
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-5 py-2.5 rounded-lg flex items-center gap-2 text-[13px] font-semibold text-white"
              style={{ background: 'var(--accent)', boxShadow: '0 2px 8px rgba(99,102,241,0.3)' }}
            >
              <Plus size={16} /> Add Your First Proxies
            </button>
          </div>
        ) : filteredProxies.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Search size={28} style={{ color: 'var(--text-muted)' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>No proxies match your filters</p>
            <button
              onClick={() => { setSearchTerm(''); setStatusFilter('all'); setTypeFilter('all'); }}
              className="text-[12px] font-medium"
              style={{ color: 'var(--accent-light)' }}
            >
              Clear all filters
            </button>
          </div>
        ) : (
          <table className="w-full min-w-[1050px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th className="w-10 px-4 py-2.5 text-left sticky top-0" style={{ background: 'var(--bg-surface)' }}>
                  <input
                    type="checkbox"
                    checked={selectedProxies.size === filteredProxies.length && filteredProxies.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                  />
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Type</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Host</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Port</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Auth</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Provider</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Folder</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Profiles</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Status</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Speed</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Checked</th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider sticky top-0 w-28" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProxies.map(proxy => {
                const isSelected = selectedProxies.has(proxy.id);
                const isTesting = testingProxies.has(proxy.id);
                const assignedProfiles = getAssignedProfiles(proxy);
                const unassignedProfiles = getUnassignedProfiles();

                return (
                  <tr
                    key={proxy.id}
                    className="group transition-colors"
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      background: isSelected ? 'var(--accent-subtle, rgba(99,102,241,0.06))' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(proxy.id)}
                        className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                      />
                    </td>

                    <td className="px-3 py-2.5">
                      <span className="text-[11px] uppercase font-bold px-2 py-0.5 rounded" style={{
                        background: proxy.type === 'socks5' || proxy.type === 'socks4' ? 'rgba(139,92,246,0.1)' : 'rgba(59,130,246,0.1)',
                        color: proxy.type === 'socks5' || proxy.type === 'socks4' ? '#a78bfa' : '#60a5fa',
                      }}>
                        {proxy.type}
                      </span>
                    </td>

                    <td className="px-3 py-2.5">
                      <span className="text-[13px] font-mono flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                        {proxy.country && <CountryFlag code={proxy.country} />}
                        {proxy.host}
                        {proxy.country && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded" style={{ background: 'rgba(59,130,246,0.1)', color: '#60a5fa' }}>{proxy.country}</span>}
                      </span>
                    </td>

                    <td className="px-3 py-2.5">
                      <span className="text-[13px] font-mono tabular-nums" style={{ color: 'var(--text-secondary)' }}>{proxy.port}</span>
                    </td>

                    <td className="px-3 py-2.5">
                      {proxy.username ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                          <CheckCircle size={9} /> Auth
                        </span>
                      ) : (
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>None</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <span className="text-[12px] capitalize" style={{ color: 'var(--text-secondary)' }}>
                        {proxy.provider && proxy.provider !== 'custom' ? proxy.provider : 'Custom'}
                      </span>
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="relative" ref={folderDropdownProxy === proxy.id ? folderDropdownRef : undefined}>
                        {(() => {
                          const folder = folders.find(f => f.id === proxy.folderId);
                          return (
                            <button
                              onClick={() => setFolderDropdownProxy(folderDropdownProxy === proxy.id ? null : proxy.id)}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                              style={{
                                background: folder ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                                color: folder ? 'var(--accent-light)' : 'var(--text-muted)',
                                border: `1px solid ${folder ? 'var(--accent)' : 'var(--border-default)'}`,
                              }}
                            >
                              {folder ? (
                                <>{folder.icon && <span>{folder.icon}</span>} {folder.name}</>
                              ) : (
                                <><FolderOpen size={9} /> None</>
                              )}
                            </button>
                          );
                        })()}
                        {folderDropdownProxy === proxy.id && (
                          <div className="absolute top-full left-0 mt-1 w-44 rounded-lg shadow-xl z-50 overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
                            <div className="py-1 max-h-48 overflow-auto">
                              <button
                                onClick={() => handleChangeFolder(proxy.id, null)}
                                className="w-full px-3 py-1.5 text-left text-[12px] transition-colors flex items-center gap-2"
                                style={{ color: !proxy.folderId ? 'var(--accent-light)' : 'var(--text-primary)' }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                              >
                                No Folder
                              </button>
                              {folders.map(f => (
                                <button
                                  key={f.id}
                                  onClick={() => handleChangeFolder(proxy.id, f.id)}
                                  className="w-full px-3 py-1.5 text-left text-[12px] transition-colors flex items-center gap-2"
                                  style={{ color: proxy.folderId === f.id ? 'var(--accent-light)' : 'var(--text-primary)' }}
                                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                >
                                  {f.icon && <span>{f.icon}</span>}
                                  {f.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="relative" ref={assignDropdownProxy === proxy.id ? assignDropdownRef : undefined}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {assignedProfiles.map(p => (
                            <span key={p.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>
                              {p.name}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleUnassignProfile(p.id); }}
                                className="hover:opacity-70"
                                title={`Remove proxy from ${p.name}`}
                              >
                                <X size={9} />
                              </button>
                            </span>
                          ))}
                          <button
                            onClick={() => setAssignDropdownProxy(assignDropdownProxy === proxy.id ? null : proxy.id)}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                            style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
                            title="Assign to profile"
                          >
                            <Link2 size={9} /> Assign
                          </button>
                        </div>
                        {assignDropdownProxy === proxy.id && (
                          <div className="absolute top-full left-0 mt-1 w-48 rounded-lg shadow-xl z-50 overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}>
                            <div className="py-1 max-h-48 overflow-auto">
                              {unassignedProfiles.length === 0 ? (
                                <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>All profiles have a proxy</div>
                              ) : (
                                unassignedProfiles.map(p => (
                                  <button
                                    key={p.id}
                                    onClick={() => handleAssignToProfile(proxy, p.id)}
                                    className="w-full px-3 py-1.5 text-left text-[12px] transition-colors flex items-center gap-2"
                                    style={{ color: 'var(--text-primary)' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    {p.name}
                                  </button>
                                ))
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-2.5">
                      {isTesting ? (
                        <span className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--accent-light)' }}>
                          <RefreshCw size={12} className="animate-spin" /> Testing
                        </span>
                      ) : proxy.isHealthy === true ? (
                        <span className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--success)' }}>
                          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} /> Healthy
                        </span>
                      ) : proxy.isHealthy === false ? (
                        <span className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--danger)' }}>
                          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--danger)' }} /> Failed
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--text-muted)', opacity: 0.4 }} /> Untested
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      {proxy.responseTime ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-mono tabular-nums" style={{ color: getSpeedColor(proxy.responseTime) }}>
                            {proxy.responseTime}ms
                          </span>
                          <span className="text-[10px]" style={{ color: getSpeedColor(proxy.responseTime) }}>
                            {getSpeedLabel(proxy.responseTime)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <Clock size={10} />
                        {formatRelativeTime(proxy.lastCheck)}
                      </span>
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => copyProxy(proxy)}
                          className="p-1.5 rounded-md transition-colors"
                          style={{ color: 'var(--text-muted)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          title="Copy proxy"
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          onClick={() => testProxy(proxy.id)}
                          disabled={isTesting}
                          className="p-1.5 rounded-md transition-colors disabled:opacity-40"
                          style={{ color: 'var(--text-muted)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          title="Test proxy"
                        >
                          <Shield size={13} />
                        </button>
                        <button
                          onClick={() => removeProxy(proxy.id)}
                          className="p-1.5 rounded-md transition-colors"
                          style={{ color: 'var(--danger)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          title="Remove proxy"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Proxies Modal */}
      {showAddModal && (
        <div className="fixed inset-0 flex items-center justify-center z-50 modal-backdrop non-draggable" onClick={e => { if (e.target === e.currentTarget) setShowAddModal(false); }}>
          <div className="rounded-xl w-full max-w-[95vw] lg:max-w-2xl overflow-hidden shadow-2xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }} onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div>
                <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Add Proxies</h2>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Paste one proxy per line in any format</p>
              </div>
              <button onClick={() => setShowAddModal(false)} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <X size={18} />
              </button>
            </div>

            <div className="p-6">
              {/* Format hints */}
              <div className="mb-4 grid grid-cols-2 gap-2">
                {[
                  'protocol://user:pass@host:port',
                  'host:port:user:pass',
                  'protocol://host:port',
                  'host:port',
                ].map(fmt => (
                  <div key={fmt} className="px-3 py-1.5 rounded-lg text-[11px] font-mono" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                    {fmt}
                  </div>
                ))}
              </div>

              {/* Folder selector */}
              {folders.length > 0 && (
                <div className="mb-3">
                  <label className="block text-[12px] font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Assign to folder (optional)</label>
                  <select
                    value={addProxyFolderId}
                    onChange={e => setAddProxyFolderId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-[13px]"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  >
                    <option value="">No folder</option>
                    {folders.map(f => (
                      <option key={f.id} value={f.id}>{f.icon ? f.icon + ' ' : ''}{f.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="relative">
                <textarea
                  value={bulkProxies}
                  onChange={e => setBulkProxies(e.target.value)}
                  placeholder="http://user:pass@proxy.example.com:8080&#10;socks5://proxy2.example.com:1080&#10;192.168.1.1:3128:admin:secret"
                  className="w-full h-56 px-3 py-2 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  autoFocus
                />
                {/* Line count badge */}
                {lineCount > 0 && (
                  <span className="absolute bottom-3 right-3 px-2 py-0.5 rounded text-[11px] font-medium"
                    style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>
                    {lineCount} prox{lineCount > 1 ? 'ies' : 'y'}
                  </span>
                )}
              </div>
            </div>

            <div className="px-6 py-4 flex justify-end gap-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => { setShowAddModal(false); setBulkProxies(''); setAddProxyFolderId(''); }}
                className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>
                Cancel
              </button>
              <button onClick={handleAddBulkProxies}
                disabled={lineCount === 0 || adding}
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white transition-all flex items-center gap-2 disabled:opacity-40"
                style={{ background: 'var(--accent)' }}>
                {adding ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                {adding ? 'Adding...' : `Add ${lineCount > 0 ? `${lineCount} Prox${lineCount > 1 ? 'ies' : 'y'}` : 'Proxies'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProxyManagerPage;
