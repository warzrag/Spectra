import React, { useState, useEffect } from 'react';
import { Puzzle, Plus, FolderOpen, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { Extension } from '../../types';
import {
  subscribeToExtensions,
  registerExtension,
  setExtensionEnabled,
  unregisterExtension,
} from '../services/firestore-service';

const ExtensionsPage: React.FC = () => {
  const { showToast } = useToast();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [localInstalled, setLocalInstalled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  // Subscribe to Firestore extensions
  useEffect(() => {
    const unsub = subscribeToExtensions((exts) => {
      setExtensions(exts);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Check which extensions are installed locally
  useEffect(() => {
    if (!window.electronAPI?.extensions?.getAll) return;
    window.electronAPI.extensions.getAll().then((localExts: any[]) => {
      setLocalInstalled(new Set(localExts.map((e: any) => e.id)));
    }).catch(console.error);
  }, [extensions]);

  const doInstall = async (pathToInstall: string) => {
    const result = await window.electronAPI.extensions.install(pathToInstall);
    if (!result.success) {
      showToast(`Failed to install extension: ${result.error}`, 'error');
      return;
    }

    const ext = result.extension;
    await registerExtension({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.description,
      enabled: true,
      localPath: ext.localPath,
      createdAt: new Date().toISOString(),
    });
  };

  const handleInstallFile = async () => {
    if (!window.electronAPI?.extensions) return;
    setInstalling(true);
    try {
      const filePath = await window.electronAPI.extensions.selectFile();
      if (!filePath) { setInstalling(false); return; }
      await doInstall(filePath);
    } catch (error) {
      console.error('Install error:', error);
      showToast('Failed to install extension', 'error');
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallFolder = async () => {
    if (!window.electronAPI?.extensions?.selectFolder) return;
    setInstalling(true);
    try {
      const folderPath = await window.electronAPI.extensions.selectFolder();
      if (!folderPath) { setInstalling(false); return; }
      await doInstall(folderPath);
    } catch (error) {
      console.error('Install error:', error);
      showToast('Failed to install extension', 'error');
    } finally {
      setInstalling(false);
    }
  };

  const handleToggle = async (ext: Extension) => {
    try {
      await setExtensionEnabled(ext.id, !ext.enabled);
    } catch (error) {
      console.error('Toggle error:', error);
    }
  };

  const handleRemove = async (ext: Extension) => {
    try {
      if (window.electronAPI?.extensions?.remove) {
        await window.electronAPI.extensions.remove(ext.id);
      }
      await unregisterExtension(ext.id);
    } catch (error) {
      console.error('Remove error:', error);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[18px] font-bold" style={{ color: 'var(--text-primary)' }}>Extensions</h1>
          <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Manage browser extensions loaded in all instances
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleInstallFolder}
            disabled={installing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors border"
            style={{ borderColor: 'var(--border)', color: 'var(--text-primary)', background: 'var(--bg-elevated)' }}
          >
            {installing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FolderOpen size={14} />
            )}
            Add Folder
          </button>
          <button
            onClick={handleInstallFile}
            disabled={installing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-white transition-colors"
            style={{ background: 'var(--accent)' }}
          >
            {installing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            Add .crx / .zip
          </button>
        </div>
      </div>

      {/* Extension List */}
      {extensions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
            <Puzzle size={36} style={{ color: 'var(--text-muted)' }} />
          </div>
          <div className="text-center">
            <p className="text-[14px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              No extensions installed
            </p>
            <p className="text-[12px] mt-1 max-w-sm" style={{ color: 'var(--text-muted)' }}>
              Upload a .crx, .zip file, or select an unpacked extension folder. Extensions will be loaded automatically when launching any instance.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2 overflow-auto">
          {extensions.map((ext) => {
            const isLocal = localInstalled.has(ext.id);
            return (
              <div
                key={ext.id}
                className="flex items-center gap-4 p-4 rounded-xl border transition-colors"
                style={{
                  background: 'var(--bg-elevated)',
                  borderColor: 'var(--border)',
                }}
              >
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: ext.enabled ? 'var(--accent-subtle)' : 'var(--bg-base)' }}
                >
                  <Puzzle size={18} style={{ color: ext.enabled ? 'var(--accent)' : 'var(--text-muted)' }} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {ext.name}
                    </span>
                    {ext.version && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                        v{ext.version}
                      </span>
                    )}
                    {!isLocal && (
                      <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
                        <AlertCircle size={10} />
                        Not installed locally
                      </span>
                    )}
                  </div>
                  {ext.description && (
                    <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                      {ext.description}
                    </p>
                  )}
                </div>

                <button
                  onClick={() => handleToggle(ext)}
                  className="relative w-10 h-5 rounded-full flex-shrink-0 transition-colors"
                  style={{ background: ext.enabled ? 'var(--accent)' : 'var(--bg-base)' }}
                >
                  <div
                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                    style={{ left: ext.enabled ? '22px' : '2px' }}
                  />
                </button>

                <button
                  onClick={() => handleRemove(ext)}
                  className="p-2 rounded-lg transition-colors hover:bg-red-500/10"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ExtensionsPage;
