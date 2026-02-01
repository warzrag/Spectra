import React from 'react';
import { Download, RotateCw, AlertTriangle, CheckCircle } from 'lucide-react';

interface ForceUpdateModalProps {
  version: string;
  releaseNotes?: string;
  downloadPercent: number | null; // null = not started, 0-100 = downloading
  downloaded: boolean;
}

const ForceUpdateModal: React.FC<ForceUpdateModalProps> = ({ version, releaseNotes, downloadPercent, downloaded }) => {
  const handleStartDownload = () => {
    (window as any).electronAPI.update.startDownload();
  };

  const handleInstall = () => {
    (window as any).electronAPI.update.installUpdate();
  };

  const isDownloading = downloadPercent !== null && !downloaded;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-[9999]"
      style={{ background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(8px)' }}
    >
      <div
        className="rounded-2xl w-full max-w-md overflow-hidden shadow-2xl text-center"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
      >
        {/* Icon */}
        <div className="pt-10 pb-2 flex justify-center">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: downloaded ? 'rgba(34, 197, 94, 0.1)' : 'rgba(245, 158, 11, 0.1)',
              border: `1px solid ${downloaded ? 'rgba(34, 197, 94, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`,
            }}
          >
            {downloaded ? (
              <CheckCircle size={32} style={{ color: '#22c55e' }} />
            ) : (
              <AlertTriangle size={32} style={{ color: '#f59e0b' }} />
            )}
          </div>
        </div>

        {/* Content */}
        <div className="px-8 pb-2">
          <h2 className="text-xl font-bold mt-4" style={{ color: 'var(--text-primary)' }}>
            {downloaded ? 'Update Ready' : 'Update Required'}
          </h2>
          <p className="text-[14px] mt-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {downloaded ? (
              <>Version <span className="font-semibold" style={{ color: '#22c55e' }}>{version}</span> is ready to install.<br />Spectra will restart automatically.</>
            ) : isDownloading ? (
              <>Downloading version <span className="font-semibold" style={{ color: '#818cf8' }}>{version}</span>...</>
            ) : (
              <>A new version <span className="font-semibold" style={{ color: '#818cf8' }}>{version}</span> is available.<br />Please update Spectra to continue.</>
            )}
          </p>
        </div>

        {/* Release notes */}
        {releaseNotes && !isDownloading && !downloaded && (
          <div className="px-8 pt-3">
            <div
              className="rounded-lg p-3 text-left"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
            >
              <p className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>What's new:</p>
              <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {releaseNotes}
              </p>
            </div>
          </div>
        )}

        {/* Progress bar */}
        {isDownloading && (
          <div className="px-8 pt-4">
            <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${downloadPercent}%`,
                  background: 'linear-gradient(90deg, #6366f1, #7c3aed)',
                }}
              />
            </div>
            <p className="text-[12px] mt-2 font-medium" style={{ color: 'var(--text-muted)' }}>
              {downloadPercent}%
            </p>
          </div>
        )}

        {/* Buttons */}
        <div className="px-8 pb-8 pt-6 space-y-3">
          {downloaded ? (
            <button
              onClick={handleInstall}
              className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-white font-semibold transition-all hover:scale-[1.02]"
              style={{
                background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                boxShadow: '0 4px 16px rgba(34, 197, 94, 0.3)',
              }}
            >
              <RotateCw size={18} />
              Install & Restart
            </button>
          ) : isDownloading ? (
            <button
              disabled
              className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-white font-semibold opacity-70 cursor-not-allowed"
              style={{ background: 'linear-gradient(135deg, #6366f1, #7c3aed)' }}
            >
              <Download size={18} className="animate-pulse" />
              Downloading...
            </button>
          ) : (
            <button
              onClick={handleStartDownload}
              className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-white font-semibold transition-all hover:scale-[1.02]"
              style={{
                background: 'linear-gradient(135deg, #6366f1, #7c3aed)',
                boxShadow: '0 4px 16px rgba(99, 102, 241, 0.3)',
              }}
            >
              <Download size={18} />
              Download Update
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ForceUpdateModal;
