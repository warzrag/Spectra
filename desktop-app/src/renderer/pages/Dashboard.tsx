import React, { useState, useEffect } from 'react';
import { Plus, Trash2, MoveRight, Search, Play, MoreVertical, Globe, Shield, Smartphone, Wifi, Circle, Copy, ExternalLink, Settings, ArrowUpDown, Tag, Monitor, UserPlus, Upload, Download, ArrowLeft, Users, FolderOpen, Edit, FileText, ChevronRight, ChevronDown, Lock, Loader2, Rocket, GripVertical } from 'lucide-react';
import MoveFolderModal from '../components/MoveFolderModal';
import AssignProfileModal from '../components/AssignProfileModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { logActivity } from '../services/firestore-service';
import { Profile, Folder, AppSettings, Platform, ProfileStatus } from '../../types';
import { isLockedByOther } from '../services/profile-sync-service';

interface DashboardProps {
  profiles: Profile[];
  folders: Folder[];
  loading: boolean;
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  settings: AppSettings;
  onCreateProfile: (profileData: any) => void;
  onUpdateProfile: (profileId: string, profileData: any) => void;
  onDeleteProfile: (profileId: string) => void;
  onLaunchProfile: (profile: any) => void;
  onBulkLaunch: (profileIds: string[]) => void;
  bulkLaunching: { total: number; current: number; name: string } | null;
  onMoveProfile: (profileId: string, folderId: string | null) => void;
  onShowCreateModal: () => void;
  onEditProfile: (profile: Profile) => void;
  onCloneProfile: (profile: Profile) => void;
}

const Dashboard: React.FC<DashboardProps> = ({
  profiles,
  folders,
  loading,
  selectedFolderId,
  onSelectFolder,
  settings,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
  onLaunchProfile,
  onBulkLaunch,
  bulkLaunching,
  onMoveProfile,
  onShowCreateModal,
  onEditProfile,
  onCloneProfile,
}) => {
  const { user, isAdmin, isVA } = useAuth();
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [activeProfiles, setActiveProfiles] = useState<string[]>([]);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'created' | 'lastUsed' | 'custom'>(settings.sortBy as any || 'custom');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(settings.sortOrder || 'asc');
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [assignProfileId, setAssignProfileId] = useState<string | null>(null);
  const [bulkAssignMode, setBulkAssignMode] = useState(false);
  const [statusMenuId, setStatusMenuId] = useState<string | null>(null);
  const [showBulkStatusMenu, setShowBulkStatusMenu] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);

  const statusOptions: { id: ProfileStatus; label: string; color: string; bg: string }[] = [
    { id: 'active', label: 'Active', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
    { id: 'shadowBanned', label: 'Shadow Ban', color: '#f97316', bg: 'rgba(249,115,22,0.1)' },
    { id: 'banned', label: 'Banned', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    { id: 'none', label: 'No Status', color: 'var(--text-muted)', bg: 'var(--bg-elevated)' },
  ];

  useEffect(() => {
    if (window.electronAPI?.profiles?.getActive) {
      window.electronAPI.profiles.getActive().then(setActiveProfiles).catch(console.error);
    }
    if (window.electronAPI?.profiles?.onActiveUpdate) {
      const unsubscribe = window.electronAPI.profiles.onActiveUpdate(setActiveProfiles);
      return () => unsubscribe();
    }
  }, []);

  useEffect(() => {
    if (openMenuId || statusMenuId) {
      const handler = () => { setOpenMenuId(null); setStatusMenuId(null); };
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [openMenuId, statusMenuId]);

  // Reset selection when navigating between folders
  useEffect(() => {
    setSelectedProfiles([]);
    setSearchTerm('');
    setFilterTag(null);
  }, [selectedFolderId]);

  // Drag & drop reorder handler
  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId || sortBy !== 'custom') return;

    // Build current visual order
    const currentList = localOrder
      ? localOrder.map(id => filteredProfiles.find(p => p.id === id)).filter(Boolean) as Profile[]
      : [...filteredProfiles];

    const fromIdx = currentList.findIndex(p => p.id === dragId);
    const toIdx = currentList.findIndex(p => p.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    // Move item in the list
    const [moved] = currentList.splice(fromIdx, 1);
    currentList.splice(toIdx, 0, moved);

    // Set local order immediately (visual feedback)
    const newOrder = currentList.map(p => p.id);
    setLocalOrder(newOrder);

    // Save to Firestore in background
    newOrder.forEach((id, i) => {
      onUpdateProfile(id, { sortIndex: i });
    });

    setDragId(null);
    setDragOverId(null);
  };

  // Get all unique tags
  const allTags = Array.from(new Set(profiles.flatMap(p => p.tags || [])));

  // Get child folder IDs for hierarchical filtering
  const getChildFolderIds = (parentId: string) =>
    folders.filter(f => f.parentId === parentId).map(f => f.id);

  // Filter profiles for the instance table view
  const filteredProfiles = profiles
    .filter(profile => {
      const matchesSearch = profile.name.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesFolder = selectedFolderId === '__none__'
        ? !profile.folderId
        : selectedFolderId === null
          ? true
          : profile.folderId === selectedFolderId ||
            getChildFolderIds(selectedFolderId).includes(profile.folderId || '');
      const matchesTag = filterTag === null ? true : (profile.tags || []).includes(filterTag);
      return matchesSearch && matchesFolder && matchesTag;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'custom') {
        if (localOrder) {
          const ai = localOrder.indexOf(a.id);
          const bi = localOrder.indexOf(b.id);
          cmp = (ai === -1 ? 999999 : ai) - (bi === -1 ? 999999 : bi);
        } else {
          // Use sortIndex, fallback to creation date order
          const ai = a.sortIndex ?? new Date(a.createdAt).getTime();
          const bi = b.sortIndex ?? new Date(b.createdAt).getTime();
          cmp = ai - bi;
        }
      }
      else if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'created') cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      else if (sortBy === 'lastUsed') cmp = new Date(a.lastUsed || 0).getTime() - new Date(b.lastUsed || 0).getTime();
      return sortOrder === 'desc' ? -cmp : cmp;
    });

  const handleSelectProfile = (profileId: string) => {
    setSelectedProfiles(prev =>
      prev.includes(profileId) ? prev.filter(id => id !== profileId) : [...prev, profileId]
    );
  };

  const handleSelectAll = () => {
    if (selectedProfiles.length === filteredProfiles.length) {
      setSelectedProfiles([]);
    } else {
      setSelectedProfiles(filteredProfiles.map(p => p.id));
    }
  };

  const handleBulkDelete = () => {
    if (window.confirm(`Delete ${selectedProfiles.length} instances?`)) {
      selectedProfiles.forEach(id => onDeleteProfile(id));
      setSelectedProfiles([]);
    }
  };

  const toggleSort = (col: 'name' | 'created' | 'lastUsed') => {
    if (sortBy === col) setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortOrder('desc'); }
  };

  const handleImportCookies = async (profile: Profile) => {
    setOpenMenuId(null);
    if (!window.electronAPI?.cookies) return;

    try {
      const fileContent = await window.electronAPI.cookies.selectFile();
      if (!fileContent) return;

      // Auto-detect format: JSON starts with [ or {, otherwise Netscape
      const trimmed = fileContent.trim();
      const format = (trimmed.startsWith('[') || trimmed.startsWith('{')) ? 'json' as const : 'netscape' as const;
      const result = await window.electronAPI.cookies.import(profile.id, fileContent, format);
      if (result.success) {
        showToast(`Imported ${result.count} cookies into "${profile.name}"`, 'success');
        if (user) {
          logActivity({
            userId: user.uid, userName: user.email,
            action: 'cookies_imported', targetProfileId: profile.id, targetProfileName: profile.name,
            timestamp: new Date().toISOString(),
            metadata: { count: result.count, format },
          }).catch(() => {});
        }
      }
    } catch (error) {
      console.error('Cookie import failed:', error);
      showToast('Failed to import cookies', 'error');
    }
  };

  const handleExportCookies = async (profile: Profile) => {
    setOpenMenuId(null);
    if (!window.electronAPI?.cookies) return;

    try {
      const result = await window.electronAPI.cookies.export(profile.id);
      if (result.success && result.cookies.length > 0) {
        const data = JSON.stringify(result.cookies, null, 2);
        await window.electronAPI.cookies.saveFile(data, `${profile.name}-cookies.json`);
        if (user) {
          logActivity({
            userId: user.uid, userName: user.email,
            action: 'cookies_exported', targetProfileId: profile.id, targetProfileName: profile.name,
            timestamp: new Date().toISOString(),
            metadata: { count: result.cookies.length },
          }).catch(() => {});
        }
      } else {
        showToast('No cookies to export for this instance', 'warning');
      }
    } catch (error) {
      console.error('Cookie export failed:', error);
      showToast('Failed to export cookies', 'error');
    }
  };

  const handleAssign = (profileId: string, userId: string | null, userEmail: string | null) => {
    onUpdateProfile(profileId, { assignedTo: userId, assignedToEmail: userEmail });
    setAssignProfileId(null);
  };

  const handleBulkAssign = (userId: string | null, userEmail: string | null) => {
    selectedProfiles.forEach(id => {
      onUpdateProfile(id, { assignedTo: userId, assignedToEmail: userEmail });
    });
    setBulkAssignMode(false);
    setSelectedProfiles([]);
    showToast(`${selectedProfiles.length} instances assigned`, 'success');
  };

  const handleBulkStatusChange = (newStatus: ProfileStatus | undefined) => {
    selectedProfiles.forEach(id => {
      onUpdateProfile(id, { status: newStatus });
    });
    setShowBulkStatusMenu(false);
    showToast(`Status updated for ${selectedProfiles.length} instances`, 'success');
  };

  const getConnectionInfo = (profile: any) => {
    if (profile.connectionType === 'iphone') return { icon: <Smartphone size={14} />, label: 'iPhone 4G', color: '#60a5fa' };
    if (profile.connectionType === 'wifi') return { icon: <Wifi size={14} />, label: 'WiFi', color: '#34d399' };
    if (profile.connectionType === 'proxy' && profile.proxy) return { icon: <Shield size={14} />, label: profile.proxy.host || 'Proxy', color: '#a78bfa' };
    return { icon: <Globe size={14} />, label: 'Direct', color: 'var(--text-muted)' };
  };

  const getOSLabel = (os?: string) => {
    if (os === 'windows') return 'Windows';
    if (os === 'macos') return 'macOS';
    if (os === 'linux') return 'Linux';
    return '-';
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const truncateUrl = (url: string) => {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return url;
    }
  };

  const SortIcon = ({ col }: { col: 'name' | 'created' | 'lastUsed' }) => (
    <ArrowUpDown size={10} style={{ opacity: sortBy === col ? 1 : 0.3, marginLeft: 4 }} />
  );

  const platformInfo: Record<string, { icon: string; label: string }> = {
    twitter: { icon: '𝕏', label: 'Twitter' },
    instagram: { icon: '📷', label: 'Instagram' },
    tiktok: { icon: '🎵', label: 'TikTok' },
    reddit: { icon: '🔴', label: 'Reddit' },
    onlyfans: { icon: '💙', label: 'OnlyFans' },
    telegram: { icon: '✈️', label: 'Telegram' },
    other: { icon: '🌐', label: 'Other' },
  };

  const getPlatformSummary = (folderProfiles: Profile[]) => {
    const counts: Record<string, number> = {};
    folderProfiles.forEach(p => {
      const key = p.platform || 'other';
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ ...(platformInfo[key] || platformInfo.other), count }));
  };

  const assignProfile = assignProfileId ? profiles.find(p => p.id === assignProfileId) : null;

  // Current folder info for header
  const currentFolder = selectedFolderId && selectedFolderId !== '__none__'
    ? folders.find(f => f.id === selectedFolderId)
    : null;

  // ============================================================
  // VIEW 1: Model Grid (when no folder selected)
  // ============================================================
  if (selectedFolderId === null) {
    const unassignedProfiles = profiles.filter(p => !p.folderId);
    const gridSearchTerm = searchTerm.toLowerCase();
    // Only show root folders in grid view
    const rootFolders = folders.filter(f => !f.parentId);
    const filteredFolders = gridSearchTerm
      ? rootFolders.filter(f => {
          const childIds = getChildFolderIds(f.id);
          const fp = profiles.filter(p => p.folderId === f.id || childIds.includes(p.folderId || ''));
          return f.name.toLowerCase().includes(gridSearchTerm) || fp.some(p => p.name.toLowerCase().includes(gridSearchTerm));
        })
      : rootFolders;
    const filteredUnassigned = gridSearchTerm
      ? unassignedProfiles.filter(p => p.name.toLowerCase().includes(gridSearchTerm))
      : unassignedProfiles;

    if (loading) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        </div>
      );
    }

    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <header className="px-6 py-4 flex items-center justify-between gap-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <h1 className="text-[18px] font-bold" style={{ color: 'var(--text-primary)' }}>Folders</h1>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {folders.length} folder{folders.length !== 1 ? 's' : ''} &middot; {profiles.length} instance{profiles.length !== 1 ? 's' : ''} total
            </p>
          </div>
          <div className="relative w-64">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search folders & instances..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg text-[13px]"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
        </header>

        {/* Grid */}
        <div className="flex-1 overflow-auto p-6">
          {filteredFolders.length === 0 && filteredUnassigned.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
                <FolderOpen size={36} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div className="text-center">
                <p className="text-[14px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>No folders yet</p>
                <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  Create a folder in the sidebar to get started
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredFolders.map(folder => {
                const childIds = getChildFolderIds(folder.id);
                const folderProfiles = profiles.filter(p => p.folderId === folder.id || childIds.includes(p.folderId || ''));
                const activeCount = folderProfiles.filter(p => activeProfiles.includes(p.id)).length;
                const lastActivity = folderProfiles.reduce((max, p) => {
                  const t = p.lastUsed || p.createdAt || '';
                  return t > max ? t : max;
                }, '');

                return (
                  <button
                    key={folder.id}
                    onClick={() => onSelectFolder(folder.id)}
                    className="text-left p-5 rounded-xl transition-all group"
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-default)',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = 'var(--accent)';
                      e.currentTarget.style.boxShadow = '0 4px 20px rgba(99, 102, 241, 0.1)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = 'var(--border-default)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    {/* Icon + Active badge */}
                    <div className="flex items-start justify-between mb-3">
                      <div
                        className="w-12 h-12 rounded-xl flex items-center justify-center text-xl"
                        style={{ background: folder.color ? `${folder.color}20` : 'var(--bg-elevated)' }}
                      >
                        <span style={{ color: folder.color }}>{folder.icon || '\uD83D\uDCC1'}</span>
                      </div>
                      {activeCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                          <Circle size={6} className="fill-current status-dot-active" />
                          {activeCount} active
                        </span>
                      )}
                    </div>

                    {/* Name */}
                    <h3 className="text-[14px] font-semibold truncate mb-1" style={{ color: 'var(--text-primary)' }}>
                      {folder.name}
                      {childIds.length > 0 && (
                        <span className="ml-1.5 text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
                          ({childIds.length} sub)
                        </span>
                      )}
                    </h3>

                    {/* Stats */}
                    <div className="flex items-center gap-3 text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
                      <span className="flex items-center gap-1">
                        <Users size={12} />
                        {folderProfiles.length} instance{folderProfiles.length !== 1 ? 's' : ''}
                      </span>
                      {lastActivity && (
                        <span>{formatDate(lastActivity)}</span>
                      )}
                    </div>

                    {/* Platform summary */}
                    {folderProfiles.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {getPlatformSummary(folderProfiles).slice(0, 4).map(p => (
                          <span key={p.label} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                            {p.icon} {p.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}

              {/* Unassigned card */}
              {filteredUnassigned.length > 0 && (
                <button
                  onClick={() => onSelectFolder('__none__')}
                  className="text-left p-5 rounded-xl transition-all"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px dashed var(--border-default)',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = 'var(--text-muted)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--border-default)';
                  }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl" style={{ background: 'var(--bg-elevated)' }}>
                      <FolderOpen size={20} style={{ color: 'var(--text-muted)' }} />
                    </div>
                  </div>
                  <h3 className="text-[14px] font-semibold truncate mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Unassigned
                  </h3>
                  <div className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    <Users size={12} />
                    {filteredUnassigned.length} instance{filteredUnassigned.length !== 1 ? 's' : ''}
                  </div>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ============================================================
  // VIEW 2: Instance Table (when a folder is selected)
  // ============================================================
  return (
    <div className="h-full flex flex-col">
      {/* Folder Header with Back button */}
      <header className="px-5 py-3 flex items-center justify-between gap-4 flex-wrap" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <button
            onClick={() => onSelectFolder(null)}
            className="p-1.5 rounded-lg transition-colors shrink-0"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <ArrowLeft size={18} />
          </button>

          {currentFolder ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-lg" style={{ color: currentFolder.color }}>{currentFolder.icon || '\uD83D\uDCC1'}</span>
              <h2 className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{currentFolder.name}</h2>
            </div>
          ) : (
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>Unassigned Instances</h2>
          )}

          <div className="relative flex-1 max-w-xs ml-3">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search instances..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg text-[13px]"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {selectedProfiles.length > 0 && (
            <>
              <button
                onClick={() => onBulkLaunch(selectedProfiles)}
                disabled={!!bulkLaunching}
                className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                style={{ background: 'var(--success-subtle, rgba(34,197,94,0.1))', border: '1px solid var(--success, #22c55e)', color: 'var(--success, #22c55e)' }}
              >
                {bulkLaunching ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {bulkLaunching.current}/{bulkLaunching.total}
                  </>
                ) : (
                  <>
                    <Rocket size={14} />
                    Launch ({selectedProfiles.length})
                  </>
                )}
              </button>
              <button
                onClick={() => setShowMoveModal(true)}
                className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
              >
                <MoveRight size={14} />
                Move ({selectedProfiles.length})
              </button>
              {isAdmin && (
                <button
                  onClick={() => setBulkAssignMode(true)}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)', color: 'var(--accent-light)' }}
                >
                  <UserPlus size={14} />
                  Assign ({selectedProfiles.length})
                </button>
              )}
              <div className="relative">
                <button
                  onClick={() => setShowBulkStatusMenu(!showBulkStatusMenu)}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
                >
                  <Circle size={14} />
                  Status ({selectedProfiles.length})
                </button>
                {showBulkStatusMenu && (
                  <div
                    className="absolute right-0 top-full mt-1 rounded-lg shadow-xl z-20 py-1 min-w-[140px]"
                    style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                    onClick={e => e.stopPropagation()}
                  >
                    {statusOptions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => handleBulkStatusChange(s.id === 'none' ? undefined : s.id)}
                        className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                        style={{ color: 'var(--text-secondary)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {isAdmin && (
                <button
                  onClick={handleBulkDelete}
                  className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
                >
                  <Trash2 size={14} />
                  Delete ({selectedProfiles.length})
                </button>
              )}
            </>
          )}
          <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {filteredProfiles.length} instance{filteredProfiles.length !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      {/* Subfolder tabs when viewing a parent folder */}
      {currentFolder && (() => {
        const subfolders = folders.filter(f => f.parentId === currentFolder.id);
        if (subfolders.length === 0) return null;
        return (
          <div className="px-5 py-2 flex items-center gap-1.5 overflow-x-auto" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <button
              onClick={() => onSelectFolder(currentFolder.id)}
              className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap"
              style={{
                background: selectedFolderId === currentFolder.id ? 'var(--accent-subtle)' : 'transparent',
                color: selectedFolderId === currentFolder.id ? 'var(--accent-light)' : 'var(--text-muted)',
                border: selectedFolderId === currentFolder.id ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              All
            </button>
            {subfolders.map(sub => (
              <button
                key={sub.id}
                onClick={() => onSelectFolder(sub.id)}
                className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap flex items-center gap-1"
                style={{
                  background: selectedFolderId === sub.id ? 'var(--accent-subtle)' : 'transparent',
                  color: selectedFolderId === sub.id ? 'var(--accent-light)' : 'var(--text-muted)',
                  border: selectedFolderId === sub.id ? '1px solid var(--accent)' : '1px solid transparent',
                }}
              >
                {sub.icon && <span className="text-[12px]">{sub.icon}</span>}
                {sub.name}
                <span className="text-[10px] opacity-70">{profiles.filter(p => p.folderId === sub.id).length}</span>
              </button>
            ))}
          </div>
        );
      })()}

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="px-5 py-2 flex items-center gap-2 overflow-x-auto" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <Tag size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <button
            onClick={() => setFilterTag(null)}
            className="px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors shrink-0"
            style={{
              background: filterTag === null ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
              color: filterTag === null ? 'var(--accent-light)' : 'var(--text-muted)',
              border: '1px solid ' + (filterTag === null ? 'var(--accent)' : 'var(--border-default)'),
            }}
          >
            All
          </button>
          {allTags.map(tag => (
            <button
              key={tag}
              onClick={() => setFilterTag(filterTag === tag ? null : tag)}
              className="px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors shrink-0"
              style={{
                background: filterTag === tag ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                color: filterTag === tag ? 'var(--accent-light)' : 'var(--text-muted)',
                border: '1px solid ' + (filterTag === tag ? 'var(--accent)' : 'var(--border-default)'),
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Loading instances...</div>
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
              <Users size={28} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div className="text-center">
              <p className="text-[14px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                {searchTerm ? 'No instances found' : 'No instances yet'}
              </p>
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {searchTerm ? 'Try a different search' : 'Create your first instance to get started'}
              </p>
            </div>
            {!searchTerm && isAdmin && (
              <button
                onClick={onShowCreateModal}
                className="px-4 py-2 rounded-lg flex items-center gap-2 text-[13px] font-medium text-white"
                style={{ background: 'var(--accent)' }}
              >
                <Plus size={16} />
                Create Instance
              </button>
            )}
          </div>
        ) : (
          <table className="profile-table w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th className="w-10 px-3 py-2.5 text-left">
                  <input
                    type="checkbox"
                    checked={selectedProfiles.length === filteredProfiles.length && filteredProfiles.length > 0}
                    onChange={handleSelectAll}
                    className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                  />
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none" style={{ color: 'var(--text-muted)' }} onClick={() => toggleSort('name')}>
                  <span className="flex items-center">Instance <SortIcon col="name" /></span>
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Status</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Account</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden xl:table-cell" style={{ color: 'var(--text-muted)' }}>OS</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden lg:table-cell" style={{ color: 'var(--text-muted)' }}>Connection</th>
                {isAdmin && (
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden lg:table-cell" style={{ color: 'var(--text-muted)' }}>Assigned To</th>
                )}
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden xl:table-cell" style={{ color: 'var(--text-muted)' }}>Tags</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider hidden 2xl:table-cell" style={{ color: 'var(--text-muted)' }}>Last URL</th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none hidden xl:table-cell" style={{ color: 'var(--text-muted)' }} onClick={() => toggleSort('lastUsed')}>
                  <span className="flex items-center">Last Used <SortIcon col="lastUsed" /></span>
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider w-44" style={{ color: 'var(--text-muted)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProfiles.map((profile) => {
                const isActive = activeProfiles.includes(profile.id);
                const isSelected = selectedProfiles.includes(profile.id);
                const conn = getConnectionInfo(profile);
                const locked = !isActive && isLockedByOther(profile, user?.uid || '');

                const isDragTarget = dragOverId === profile.id && dragId !== profile.id;
                const isDragging = dragId === profile.id;

                return (
                  <React.Fragment key={profile.id}>
                    {isDragTarget && (
                      <tr style={{ height: 3, padding: 0 }}>
                        <td colSpan={99} style={{ padding: 0, border: 'none', background: 'linear-gradient(90deg, transparent, #818cf8, transparent)', height: 3, borderRadius: 2 }} />
                      </tr>
                    )}
                  <tr
                    className="group"
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      background: isSelected ? 'var(--accent-subtle, rgba(99,102,241,0.06))' : 'transparent',
                      opacity: isDragging ? 0.25 : 1,
                      transform: isDragging ? 'scale(0.98)' : 'scale(1)',
                      transition: 'opacity 0.2s ease, transform 0.2s ease, background 0.15s ease',
                      position: 'relative',
                      zIndex: (statusMenuId === `table-${profile.id}` || openMenuId === profile.id) ? 50 : 'auto',
                    }}
                    onMouseEnter={e => { if (!isSelected && !dragId) e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('profileId', profile.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(profile.id);
                      setSortBy('custom');
                    }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverId(profile.id); }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null); }}
                    onDrop={(e) => { e.preventDefault(); handleDrop(profile.id); }}
                    onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleSelectProfile(profile.id)}
                        className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0 w-3.5 h-3.5"
                      />
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="cursor-grab active:cursor-grabbing shrink-0 opacity-0 group-hover:opacity-40 hover:!opacity-70 transition-opacity" style={{ color: 'var(--text-muted)', marginRight: -4 }}>
                          <GripVertical size={14} />
                        </div>
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-bold shrink-0"
                          style={{ background: isActive ? 'var(--success-subtle)' : 'var(--bg-overlay)', color: isActive ? 'var(--success)' : 'var(--text-muted)' }}
                        >
                          {profile.platform && platformInfo[profile.platform]
                            ? platformInfo[profile.platform].icon
                            : profile.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{profile.name}</span>
                            {profile.notes && (
                              <span className="relative group/notes shrink-0">
                                <FileText size={11} style={{ color: 'var(--text-muted)', opacity: 0.6 }} />
                                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded-lg text-[11px] whitespace-pre-wrap max-w-[200px] hidden group-hover/notes:block z-50 shadow-lg"
                                  style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                                  {profile.notes}
                                </span>
                              </span>
                            )}
                          </div>
                          {profile.platform && platformInfo[profile.platform] && (
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{platformInfo[profile.platform].label}</div>
                          )}
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-2.5">
                      {isActive ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>
                          <Circle size={6} className="fill-current status-dot-active" />
                          Running
                        </span>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Idle</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      {(() => {
                        const s = statusOptions.find(o => o.id === (profile.status || 'none'));
                        return (
                          <div className="relative">
                            <button
                              onClick={(e) => { e.stopPropagation(); setStatusMenuId(statusMenuId === `table-${profile.id}` ? null : `table-${profile.id}`); }}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium cursor-pointer transition-all hover:opacity-80"
                              style={{ background: s ? s.bg : 'var(--bg-elevated)', color: s ? s.color : 'var(--text-muted)', border: `1px solid ${s ? s.color + '33' : 'var(--border-default)'}` }}
                            >
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: s ? s.color : 'var(--text-muted)' }} />
                              {s ? s.label : 'No Status'}
                              <ChevronDown size={10} style={{ opacity: 0.6 }} />
                            </button>
                            {statusMenuId === `table-${profile.id}` && (
                              <div
                                className="absolute top-full left-0 mt-1 rounded-lg shadow-xl py-1 min-w-[150px]"
                                style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)', zIndex: 9999 }}
                                onClick={e => e.stopPropagation()}
                              >
                                {statusOptions.map(opt => (
                                  <button
                                    key={opt.id}
                                    onClick={() => {
                                      onUpdateProfile(profile.id, { status: opt.id === 'none' ? undefined : opt.id });
                                      setStatusMenuId(null);
                                    }}
                                    className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                                    style={{ color: (profile.status || 'none') === opt.id ? opt.color : 'var(--text-secondary)' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <span className="w-2 h-2 rounded-full" style={{ background: opt.color }} />
                                    {opt.label}
                                    {(profile.status || 'none') === opt.id && <span className="ml-auto text-[10px]">✓</span>}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                        <Monitor size={13} style={{ opacity: 0.6 }} />
                        <span>{getOSLabel(profile.os)}</span>
                      </div>
                    </td>

                    <td className="px-3 py-2.5 hidden lg:table-cell">
                      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: conn.color }}>
                        {conn.icon}
                        <span className="truncate max-w-[100px]">{conn.label}</span>
                      </div>
                    </td>

                    {isAdmin && (
                      <td className="px-3 py-2.5 hidden lg:table-cell">
                        {profile.assignedToEmail ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>
                            <UserPlus size={10} />
                            {profile.assignedToEmail.split('@')[0]}
                          </span>
                        ) : (
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>-</span>
                        )}
                      </td>
                    )}

                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      <div className="flex gap-1 flex-wrap">
                        {(profile.tags || []).slice(0, 2).map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-light)' }}>
                            {tag}
                          </span>
                        ))}
                        {(profile.tags || []).length > 2 && (
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>+{(profile.tags || []).length - 2}</span>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-2.5 hidden 2xl:table-cell">
                      {profile.lastUrl ? (
                        <div className="flex items-center gap-1.5 text-[12px] max-w-[150px]" style={{ color: 'var(--text-secondary)' }}>
                          <ExternalLink size={12} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <span className="truncate">{truncateUrl(profile.lastUrl)}</span>
                        </div>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{formatDate(profile.lastUsed)}</span>
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => !locked && onLaunchProfile(profile)}
                          className="px-3 py-1.5 rounded-md flex items-center gap-1.5 text-[12px] font-medium transition-all"
                          style={{
                            background: locked ? 'var(--bg-elevated)' : isActive ? 'var(--success)' : 'var(--accent)',
                            boxShadow: locked ? 'none' : isActive ? '0 1px 4px rgba(34,197,94,0.3)' : '0 1px 4px rgba(99,102,241,0.3)',
                            color: locked ? 'var(--text-muted)' : 'white',
                            cursor: locked ? 'not-allowed' : 'pointer',
                          }}
                          title={locked ? `Utilis\u00e9 par ${profile.lockedByEmail || '?'} sur ${profile.lockedByDevice || '?'}` : ''}
                        >
                          {isActive ? (
                            <><Circle size={10} className="fill-current status-dot-active" /> Active</>
                          ) : locked ? (
                            <><Lock size={12} /> Locked</>
                          ) : (
                            <><Play size={12} /> Launch</>
                          )}
                        </button>

                        <div className="relative">
                          <button
                            onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === profile.id ? null : profile.id); }}
                            className="p-1.5 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                            style={{ color: 'var(--text-muted)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <MoreVertical size={14} />
                          </button>

                          {openMenuId === profile.id && (
                            <div
                              className="absolute right-0 top-full mt-1 rounded-lg shadow-xl z-20 py-1 min-w-[170px]"
                              style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {isAdmin && (
                                <button
                                  onClick={() => { onEditProfile(profile); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <Edit size={13} /> Edit
                                </button>
                              )}

                              {isAdmin && (
                                <button
                                  onClick={() => { onCloneProfile(profile); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <Copy size={13} /> Clone
                                </button>
                              )}

                              {isAdmin && (
                                <button
                                  onClick={() => { setAssignProfileId(profile.id); setOpenMenuId(null); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <UserPlus size={13} /> Assign
                                </button>
                              )}

                              {/* Set Status submenu */}
                              <div className="relative">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setStatusMenuId(statusMenuId === profile.id ? null : profile.id); }}
                                  className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 justify-between transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <span className="flex items-center gap-2"><Circle size={13} /> Set Status</span>
                                  <ChevronRight size={12} />
                                </button>
                                {statusMenuId === profile.id && (
                                  <div
                                    className="absolute left-full top-0 ml-1 rounded-lg shadow-xl z-30 py-1 min-w-[140px]"
                                    style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                                    onClick={e => e.stopPropagation()}
                                  >
                                    {statusOptions.map(s => (
                                      <button
                                        key={s.id}
                                        onClick={() => {
                                          onUpdateProfile(profile.id, { status: s.id === 'none' ? undefined : s.id });
                                          setOpenMenuId(null);
                                          setStatusMenuId(null);
                                        }}
                                        className="w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors"
                                        style={{ color: profile.status === s.id ? s.color : 'var(--text-secondary)' }}
                                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                      >
                                        <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                                        {s.label}
                                        {profile.status === s.id && <span className="ml-auto text-[10px]">✓</span>}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>

                              <button
                                onClick={() => handleImportCookies(profile)}
                                className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                style={{ color: 'var(--text-secondary)' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                              >
                                <Upload size={13} /> Import Cookies
                              </button>

                              <button
                                onClick={() => handleExportCookies(profile)}
                                className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                style={{ color: 'var(--text-secondary)' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                              >
                                <Download size={13} /> Export Cookies
                              </button>

                              <button
                                onClick={() => setOpenMenuId(null)}
                                className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                style={{ color: 'var(--text-secondary)' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                              >
                                <Settings size={13} /> Settings
                              </button>

                              {isAdmin && (
                                <>
                                  <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '2px 0' }} />
                                  <button
                                    onClick={() => {
                                      if (window.confirm(`Delete "${profile.name}"?`)) {
                                        onDeleteProfile(profile.id);
                                        setOpenMenuId(null);
                                      }
                                    }}
                                    className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                                    style={{ color: 'var(--danger)' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                  >
                                    <Trash2 size={13} /> Delete
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showMoveModal && (
        <MoveFolderModal
          isOpen={showMoveModal}
          onClose={() => setShowMoveModal(false)}
          folders={folders}
          selectedCount={selectedProfiles.length}
          onMove={(folderId) => { selectedProfiles.forEach(id => onMoveProfile(id, folderId)); setSelectedProfiles([]); setShowMoveModal(false); }}
        />
      )}

      {assignProfile && (
        <AssignProfileModal
          profileName={assignProfile.name}
          currentAssignee={assignProfile.assignedTo}
          onClose={() => setAssignProfileId(null)}
          onAssign={(userId, userEmail) => handleAssign(assignProfile.id, userId, userEmail)}
        />
      )}

      {bulkAssignMode && (
        <AssignProfileModal
          profileName={`${selectedProfiles.length} instances`}
          onClose={() => setBulkAssignMode(false)}
          onAssign={(userId, userEmail) => handleBulkAssign(userId, userEmail)}
        />
      )}
    </div>
  );
};

export default Dashboard;
