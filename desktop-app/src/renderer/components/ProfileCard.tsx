import React, { useState, useEffect } from 'react';
import { Play, Settings, Trash2, Copy, MoreVertical, Globe, Shield, GripVertical, ExternalLink, Edit2, Check, X, Wifi, Smartphone, Circle, Info } from 'lucide-react';
import ConnectionStatus from './ConnectionStatus';
import ConnectionTest from './ConnectionTest';

interface ProfileCardProps {
  profile: any;
  selected: boolean;
  isActive?: boolean;
  onSelect: () => void;
  onLaunch: () => void;
  onUpdate: (data: any) => void;
  onDelete: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

const ProfileCard: React.FC<ProfileCardProps> = ({
  profile,
  selected,
  isActive = false,
  onSelect,
  onLaunch,
  onUpdate,
  onDelete,
  onDragStart,
  onDragEnd,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [editedUrl, setEditedUrl] = useState(profile.lastUrl || '');
  const [showConnectionInfo, setShowConnectionInfo] = useState(false);
  const [showConnectionTest, setShowConnectionTest] = useState(false);
  
  // Close menu when clicking outside
  useEffect(() => {
    if (showMenu) {
      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target.closest('.profile-menu')) {
          setShowMenu(false);
        }
      };
      
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showMenu]);

  const handleDelete = () => {
    if (window.confirm(`Delete instance "${profile.name}"?`)) {
      setShowMenu(false);
      onDelete();
      // Force blur any focused element
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  };

  const handleClone = () => {
    const clonedProfile = {
      ...profile,
      name: `${profile.name} (Copy)`,
      id: undefined,
    };
    onUpdate(clonedProfile);
  };

  const handleDragStart = (e: React.DragEvent) => {
    setIsDragging(true);
    e.dataTransfer.setData('profileId', profile.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart?.(e);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    setIsDragging(false);
    onDragEnd?.(e);
  };

  return (
    <div
      className={`bg-gray-800 border ${
        isActive ? 'border-green-500 shadow-lg shadow-green-500/20' : selected ? 'border-blue-600' : 'border-gray-700'
      } rounded-lg p-4 relative hover:border-gray-600 transition-all cursor-move ${
        isDragging ? 'opacity-50' : ''
      }`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <GripVertical size={16} className="text-gray-500 cursor-move" />
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelect}
            onClick={(e) => e.stopPropagation()}
            className="rounded border-gray-600 text-blue-600 focus:ring-blue-600 focus:ring-offset-0"
          />
          <h3 className="font-medium text-white truncate">{profile.name}</h3>
          {isActive && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded-full">
              <Circle size={8} className="fill-current" />
              Active
            </span>
          )}
        </div>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="p-1 hover:bg-gray-700 rounded transition-colors"
        >
          <MoreVertical size={16} className="text-gray-400" />
        </button>
      </div>

      <div className="space-y-2 mb-4">
        {isEditingUrl ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={editedUrl}
              onChange={(e) => setEditedUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onUpdate({ ...profile, lastUrl: editedUrl });
                  setIsEditingUrl(false);
                } else if (e.key === 'Escape') {
                  setEditedUrl(profile.lastUrl || '');
                  setIsEditingUrl(false);
                }
              }}
              className="flex-1 px-2 py-1 text-sm bg-gray-700 border border-gray-600 rounded text-white"
              placeholder="https://example.com"
              autoFocus
            />
            <button
              onClick={() => {
                onUpdate({ ...profile, lastUrl: editedUrl });
                setIsEditingUrl(false);
              }}
              className="p-1 hover:bg-gray-700 rounded"
            >
              <Check size={14} className="text-green-500" />
            </button>
            <button
              onClick={() => {
                setEditedUrl(profile.lastUrl || '');
                setIsEditingUrl(false);
              }}
              className="p-1 hover:bg-gray-700 rounded"
            >
              <X size={14} className="text-red-500" />
            </button>
          </div>
        ) : (
          <>
            {profile.lastUrl && (
              <div className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 cursor-pointer group" 
                   title={profile.lastUrl}>
                <ExternalLink size={14} className="group-hover:scale-110 transition-transform" />
                <span className="truncate flex-1">
                  {(() => {
                    try {
                      const url = new URL(profile.lastUrl);
                      return url.hostname + (url.pathname !== '/' ? url.pathname : '');
                    } catch {
                      return profile.lastUrl;
                    }
                  })()}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsEditingUrl(true);
                    setEditedUrl(profile.lastUrl);
                  }}
                  className="p-1 hover:bg-gray-700 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Edit2 size={12} />
                </button>
              </div>
            )}
            {!profile.lastUrl && (
              <div className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer hover:text-gray-400"
                   onClick={() => {
                     setIsEditingUrl(true);
                     setEditedUrl('');
                   }}>
                <Globe size={14} />
                <span>Click to set start URL</span>
              </div>
            )}
          </>
        )}
        <div className="flex items-center gap-2 text-sm text-gray-400">
          {profile.connectionType === 'iphone' && (
            <>
              <Smartphone size={14} className="text-blue-400" />
              <span>iPhone 4G</span>
              <button
                onClick={() => setShowConnectionInfo(!showConnectionInfo)}
                className="ml-2 p-1 hover:bg-gray-700 rounded"
                title="Check connection status"
              >
                <Info size={12} />
              </button>
              <button
                onClick={() => setShowConnectionTest(true)}
                className="ml-1 p-1 hover:bg-gray-700 rounded"
                title="Test connection"
              >
                <Wifi size={12} className="text-blue-400" />
              </button>
            </>
          )}
          {profile.connectionType === 'wifi' && (
            <>
              <Wifi size={14} className="text-green-400" />
              <span>Home WiFi</span>
            </>
          )}
          {profile.connectionType === 'proxy' && profile.proxy && (
            <>
              <Shield size={14} className="text-purple-400" />
              <span className="truncate">{profile.proxy.host || 'Proxy'}</span>
            </>
          )}
          {(!profile.connectionType || profile.connectionType === 'system') && (
            <>
              <Globe size={14} />
              <span>System Default</span>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onLaunch}
          className={`flex-1 ${
            isActive 
              ? 'bg-green-600 hover:bg-green-700' 
              : 'bg-blue-600 hover:bg-blue-700'
          } text-white py-2 px-3 rounded-lg flex items-center justify-center gap-2 transition-colors`}
        >
          {isActive ? (
            <>
              <Circle size={16} className="animate-pulse fill-current" />
              Active
            </>
          ) : (
            <>
              <Play size={16} />
              Launch
            </>
          )}
        </button>
        <button
          onClick={handleDelete}
          className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
          disabled={isActive}
        >
          <Trash2 size={16} className={isActive ? 'text-gray-600' : 'text-gray-400'} />
        </button>
      </div>

      {showMenu && (
        <div className="profile-menu absolute top-10 right-4 bg-gray-900 border border-gray-700 rounded-lg shadow-lg py-1 z-10">
          <button
            onClick={handleClone}
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-800 flex items-center gap-2"
          >
            <Copy size={14} />
            Clone Instance
          </button>
          <button
            onClick={() => {
              setShowMenu(false);
            }}
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-800 flex items-center gap-2"
          >
            <Settings size={14} />
            Settings
          </button>
        </div>
      )}

      {/* Connection Status Modal */}
      {showConnectionInfo && (
        <div className="absolute top-full left-0 right-0 mt-2 z-20">
          <ConnectionStatus 
            profileId={profile.id}
            connectionType={profile.connectionType}
          />
        </div>
      )}

      {/* Connection Test Modal */}
      {showConnectionTest && (
        <ConnectionTest
          connectionType={profile.connectionType || 'system'}
          onClose={() => setShowConnectionTest(false)}
        />
      )}
    </div>
  );
};

export default ProfileCard;