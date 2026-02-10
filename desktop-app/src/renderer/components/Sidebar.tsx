import React, { useState, useEffect } from 'react';
import { Plus, FolderOpen, MoreVertical, Edit, Trash2, Users, ChevronDown, ChevronRight, Globe, Puzzle, Settings, Zap, Clock, LogOut, CreditCard, UsersRound, Shield, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Folder as FolderType, AppPage } from '../../types';
import { useAuth } from '../contexts/AuthContext';

interface SidebarProps {
  activePage: AppPage;
  onNavigate: (page: AppPage) => void;
  folders: FolderType[];
  selectedFolderId: string | null;
  profileCounts: { [folderId: string]: number };
  totalProfiles: number;
  onSelectFolder: (folderId: string | null) => void;
  onCreateFolder: () => void;
  onEditFolder: (folder: FolderType) => void;
  onDeleteFolder: (folderId: string) => void;
  onCreateProfile: () => void;
  onQuickCreate: () => void;
  onMoveProfile?: (profileId: string, folderId: string | null) => void;
  onLogout: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  activePage,
  onNavigate,
  folders,
  selectedFolderId,
  profileCounts,
  totalProfiles,
  onSelectFolder,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder,
  onCreateProfile,
  onQuickCreate,
  onMoveProfile,
  onLogout,
  collapsed,
  onToggleCollapse,
}) => {
  const { user, isAdmin } = useAuth();
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [foldersExpanded, setFoldersExpanded] = useState(true);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [showNewDropdown, setShowNewDropdown] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.electronAPI.getVersion().then(v => setAppVersion(v));
  }, []);

  // Main navigation items
  const mainNavItems: { page: AppPage; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { page: 'profiles', label: 'Instances', icon: <Users size={18} /> },
    { page: 'proxies', label: 'Proxies', icon: <Globe size={18} />, adminOnly: true },
    { page: 'extensions', label: 'Extensions', icon: <Puzzle size={18} /> },
    { page: 'recycle-bin', label: 'Recycle Bin', icon: <Trash2 size={18} />, adminOnly: true },
  ];

  // Team section items
  const teamNavItems: { page: AppPage; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { page: 'billing', label: 'Billing', icon: <CreditCard size={18} />, adminOnly: true },
    { page: 'members', label: 'Members', icon: <UsersRound size={18} />, adminOnly: true },
    { page: 'activity', label: 'Action Logs', icon: <Clock size={18} />, adminOnly: true },
    { page: 'settings', label: 'Global Settings', icon: <Settings size={18} />, adminOnly: true },
  ];

  const filterItems = (items: typeof mainNavItems) => items.filter(item => !item.adminOnly || isAdmin);

  const handleContextMenu = (e: React.MouseEvent, folderId: string) => {
    e.stopPropagation();
    setContextMenuId(contextMenuId === folderId ? null : folderId);
  };

  const handleDelete = (e: React.MouseEvent, folderId: string) => {
    e.stopPropagation();
    if (window.confirm('Delete this folder? Instances will be moved to root.')) {
      onDeleteFolder(folderId);
      setContextMenuId(null);
    }
  };

  const handleEdit = (e: React.MouseEvent, folder: FolderType) => {
    e.stopPropagation();
    onEditFolder(folder);
    setContextMenuId(null);
  };

  const handleDragOver = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverFolder(folderId);
  };

  const handleDragLeave = () => setDragOverFolder(null);

  const handleDrop = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    const profileId = e.dataTransfer.getData('profileId');
    if (profileId && onMoveProfile) onMoveProfile(profileId, folderId);
    setDragOverFolder(null);
  };

  const renderNavButton = (page: AppPage, label: string, icon: React.ReactNode) => (
    <button
      key={page}
      onClick={() => onNavigate(page)}
      className={`w-full text-left ${collapsed ? 'px-0 justify-center' : 'px-3'} py-2 rounded-lg flex items-center ${collapsed ? '' : 'gap-2.5'} text-[13px] font-medium transition-colors`}
      style={{
        background: activePage === page ? 'var(--accent-subtle)' : 'transparent',
        color: activePage === page ? 'var(--accent-light)' : 'var(--text-secondary)',
      }}
      onMouseEnter={e => { if (activePage !== page) e.currentTarget.style.background = 'var(--bg-elevated)'; }}
      onMouseLeave={e => { if (activePage !== page) e.currentTarget.style.background = 'transparent'; }}
      title={collapsed ? label : undefined}
    >
      <span className={collapsed ? 'mx-auto' : ''}>{icon}</span>
      {!collapsed && <span className="flex-1">{label}</span>}
      {!collapsed && page === 'profiles' && (
        <span className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
          {totalProfiles}
        </span>
      )}
    </button>
  );

  return (
    <aside
      className={`${collapsed ? 'w-[60px]' : 'w-60'} flex flex-col shrink-0 relative transition-all duration-200`}
      style={{ background: 'var(--bg-surface)', borderRight: '1px solid var(--border-subtle)' }}
    >
      {/* Collapse toggle button */}
      <button
        onClick={onToggleCollapse}
        className="absolute -right-3 top-[52px] w-6 h-6 rounded-full flex items-center justify-center z-10 transition-colors"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent-light)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border-default)'; }}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
      </button>

      {/* Logo */}
      <div className={`${collapsed ? 'px-2 justify-center' : 'px-4'} pt-4 pb-3 flex items-center gap-3 draggable`}>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)' }}>
          <Shield size={24} className="text-white" />
        </div>
        {!collapsed && (
          <div>
            <span className="text-[20px] font-bold tracking-tight block leading-tight" style={{ color: 'var(--text-primary)' }}>
              Spectra
            </span>
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Antidetect Browser
            </span>
          </div>
        )}
      </div>

      {/* New Profile Button - only for admins */}
      {isAdmin && (
        <div className={`${collapsed ? 'px-2' : 'p-3'}`}>
          {collapsed ? (
            <button
              onClick={onCreateProfile}
              className="w-full py-2.5 rounded-lg flex items-center justify-center text-white transition-all"
              style={{ background: 'linear-gradient(135deg, #6366f1, #7c3aed)', boxShadow: '0 2px 8px rgba(99, 102, 241, 0.25)' }}
              title="New Instance"
            >
              <Plus size={18} />
            </button>
          ) : (
            <div className="relative">
              <div className="flex gap-1">
                <button
                  onClick={onCreateProfile}
                  className="flex-1 py-2.5 px-4 rounded-l-lg flex items-center justify-center gap-2 text-sm font-medium text-white transition-all"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #7c3aed)', boxShadow: '0 2px 8px rgba(99, 102, 241, 0.25)' }}
                  onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(99, 102, 241, 0.35)'}
                  onMouseLeave={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(99, 102, 241, 0.25)'}
                >
                  <Plus size={16} />
                  New Instance
                </button>
                <button
                  onClick={() => setShowNewDropdown(!showNewDropdown)}
                  className="py-2.5 px-2 rounded-r-lg text-white transition-all"
                  style={{ background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', boxShadow: '0 2px 8px rgba(99, 102, 241, 0.25)' }}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              {showNewDropdown && (
                <div
                  className="absolute left-0 right-0 top-full mt-1 rounded-lg shadow-xl z-20 overflow-hidden py-1"
                  style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                >
                  <button
                    onClick={() => { onQuickCreate(); setShowNewDropdown(false); }}
                    className="w-full px-3 py-2 text-[13px] text-left flex items-center gap-2 transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                  >
                    <Zap size={14} style={{ color: 'var(--warning)' }} />
                    Quick Create (Bulk)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Navigation */}
      <nav className={`px-2 space-y-0.5 ${isAdmin ? '' : 'pt-3'}`}>
        {filterItems(mainNavItems).map(({ page, label, icon }) => renderNavButton(page, label, icon))}
      </nav>

      {/* Folders section - only visible when on profiles page and not collapsed */}
      {activePage === 'profiles' && !collapsed && (
        <div className="flex-1 px-2 pb-2 overflow-y-auto mt-3">
          {/* Divider */}
          <div style={{ borderTop: '1px solid var(--border-subtle)' }} className="mb-3 mx-1" />

          {/* All Profiles */}
          <button
            onClick={() => onSelectFolder(null)}
            onDragOver={(e) => handleDragOver(e, null)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, null)}
            className="w-full text-left px-3 py-2 rounded-lg flex items-center gap-2.5 text-[13px] transition-colors mb-1"
            style={{
              background: selectedFolderId === null ? 'var(--bg-elevated)' : 'transparent',
              color: selectedFolderId === null ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: dragOverFolder === null ? '1px solid var(--accent)' : '1px solid transparent',
            }}
          >
            <Users size={16} style={{ opacity: 0.7 }} />
            <span className="flex-1 font-medium">All Instances</span>
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{totalProfiles}</span>
          </button>

          {/* Folders - admin only can manage */}
          <div className="mt-2">
            <div className="flex items-center justify-between px-3 mb-1">
              <button
                onClick={() => setFoldersExpanded(!foldersExpanded)}
                className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                {foldersExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Folders
              </button>
              {isAdmin && (
                <button
                  onClick={onCreateFolder}
                  className="p-1 rounded transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
                  title="Create folder"
                >
                  <Plus size={14} />
                </button>
              )}
            </div>

            {foldersExpanded && (() => {
              const rootFolders = folders.filter(f => !f.parentId);
              const getChildren = (parentId: string) => folders.filter(f => f.parentId === parentId);
              const toggleParent = (folderId: string, e: React.MouseEvent) => {
                e.stopPropagation();
                setExpandedParents(prev => {
                  const next = new Set(prev);
                  if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
                  return next;
                });
              };

              const renderFolder = (folder: FolderType, isChild = false) => {
                const children = getChildren(folder.id);
                const hasChildren = children.length > 0;
                const isExpanded = expandedParents.has(folder.id);
                const count = profileCounts[folder.id] || 0;
                const isSelected = selectedFolderId === folder.id;

                return (
                  <div key={folder.id}>
                    <div className="relative group">
                      <button
                        onClick={() => onSelectFolder(folder.id)}
                        onDragOver={(e) => handleDragOver(e, folder.id)}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, folder.id)}
                        className="w-full text-left py-2 rounded-lg flex items-center gap-2 text-[13px] transition-colors"
                        style={{
                          paddingLeft: isChild ? '2rem' : '0.75rem',
                          paddingRight: '0.75rem',
                          background: isSelected ? 'var(--bg-elevated)' : 'transparent',
                          color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                          border: dragOverFolder === folder.id ? '1px solid var(--accent)' : '1px solid transparent',
                        }}
                      >
                        {hasChildren && (
                          <span onClick={(e) => toggleParent(folder.id, e)} className="cursor-pointer shrink-0" style={{ color: 'var(--text-muted)' }}>
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </span>
                        )}
                        {!hasChildren && !isChild && <span className="w-3 shrink-0" />}
                        <span className="text-sm shrink-0" style={{ color: folder.color }}>{folder.icon || '\uD83D\uDCC1'}</span>
                        <span className="flex-1 truncate">{folder.name}</span>
                        <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{count}</span>
                        {isAdmin && (
                          <div
                            onClick={(e) => handleContextMenu(e, folder.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer p-0.5 rounded"
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-overlay)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            <MoreVertical size={14} />
                          </div>
                        )}
                      </button>

                      {contextMenuId === folder.id && (
                        <div
                          className="absolute right-2 top-full mt-1 rounded-lg shadow-xl z-10 overflow-hidden py-1 min-w-[140px]"
                          style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-default)' }}
                        >
                          <button
                            onClick={(e) => handleEdit(e, folder)}
                            className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                            style={{ color: 'var(--text-secondary)' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                          >
                            <Edit size={13} /> Edit
                          </button>
                          <button
                            onClick={(e) => handleDelete(e, folder.id)}
                            className="w-full px-3 py-1.5 text-[13px] text-left flex items-center gap-2 transition-colors"
                            style={{ color: 'var(--danger)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--danger-subtle)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <Trash2 size={13} /> Delete
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Render children if expanded */}
                    {hasChildren && isExpanded && (
                      <div className="space-y-0.5">
                        {children.map(child => renderFolder(child, true))}
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <div className="space-y-0.5">
                  {rootFolders.map(folder => renderFolder(folder))}
                  {folders.length === 0 && (
                    <p className="text-[12px] px-3 py-2" style={{ color: 'var(--text-muted)' }}>
                      No folders yet
                    </p>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Spacer when folders not shown */}
      {(activePage !== 'profiles' || collapsed) && <div className="flex-1" />}

      {/* Team Section */}
      {isAdmin && (
        <div className="px-2 pb-2">
          <div style={{ borderTop: '1px solid var(--border-subtle)' }} className="mb-2 mx-1" />
          {!collapsed && (
            <div className="px-3 mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Team
              </span>
            </div>
          )}
          <div className="space-y-0.5">
            {filterItems(teamNavItems).map(({ page, label, icon }) => renderNavButton(page, label, icon))}
          </div>
        </div>
      )}

      {/* Bottom: User info */}
      <div className={`${collapsed ? 'px-2' : 'px-3'} py-3 space-y-2`} style={{ borderTop: '1px solid var(--border-subtle)' }}>
        {user && (
          <>
            {collapsed ? (
              <div className="flex flex-col items-center gap-2">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                  style={{ background: isAdmin ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : 'linear-gradient(135deg, #059669, #10b981)' }}
                  title={user.email}
                >
                  {user.email.charAt(0).toUpperCase()}
                </div>
                <button onClick={onLogout} className="p-1.5 rounded-lg transition-colors shrink-0" title="Sign out"
                  style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger-subtle)'; e.currentTarget.style.color = 'var(--danger)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}>
                  <LogOut size={14} />
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-1">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                    style={{ background: isAdmin ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : 'linear-gradient(135deg, #059669, #10b981)' }}>
                    {user.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{user.email}</div>
                    <div className="text-[10px] uppercase font-semibold tracking-wider" style={{
                      color: isAdmin ? 'var(--accent-light)' : 'var(--success)',
                    }}>
                      {user.role}
                    </div>
                  </div>
                  <button onClick={onLogout} className="p-1.5 rounded-lg transition-colors shrink-0" title="Sign out"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger-subtle)'; e.currentTarget.style.color = 'var(--danger)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}>
                    <LogOut size={14} />
                  </button>
                </div>
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Profiles</span>
                  <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>{totalProfiles}</span>
                </div>
              </>
            )}
          </>
        )}
        {!collapsed && <div className="text-[10px] px-1" style={{ color: 'var(--text-muted)' }}>Spectra v{appVersion}</div>}
      </div>
    </aside>
  );
};

export default Sidebar;
