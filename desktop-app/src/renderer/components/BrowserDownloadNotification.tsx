import React, { useState, useEffect } from 'react';
import { Download, CheckCircle, X, Chrome } from 'lucide-react';

const BrowserDownloadNotification: React.FC = () => {
  const [download, setDownload] = useState<{ percent: number; status: string } | null>(null);
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.browser?.onDownloadProgress) return;
    const cleanup = window.electronAPI.browser.onDownloadProgress((data) => {
      setDownload(data);
      setVisible(true);
      setDismissed(false);
      if (data.percent >= 100) {
        setTimeout(() => setVisible(false), 4000);
      }
    });
    return cleanup;
  }, []);

  if (!download || !visible || dismissed) return null;

  const done = download.percent >= 100;
  const progressColor = done
    ? 'linear-gradient(90deg, #22c55e, #4ade80)'
    : 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)';

  return (
    <div
      className="fixed top-14 right-4 z-[9999]"
      style={{
        animation: 'slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div
        className="relative overflow-hidden rounded-xl shadow-2xl"
        style={{
          width: 340,
          background: 'rgba(17, 17, 19, 0.85)',
          backdropFilter: 'blur(20px) saturate(1.8)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.8)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        {/* Glow effect */}
        <div
          className="absolute -top-20 -right-20 w-40 h-40 rounded-full opacity-20 blur-3xl pointer-events-none"
          style={{ background: done ? '#22c55e' : '#6366f1' }}
        />

        {/* Content */}
        <div className="relative p-4">
          <div className="flex items-start gap-3">
            {/* Icon */}
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={{
                background: done
                  ? 'rgba(34, 197, 94, 0.15)'
                  : 'rgba(99, 102, 241, 0.15)',
              }}
            >
              {done ? (
                <CheckCircle size={20} style={{ color: '#4ade80' }} />
              ) : (
                <Chrome size={20} className="animate-pulse" style={{ color: '#818cf8' }} />
              )}
            </div>

            {/* Text */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold" style={{ color: '#fafafa' }}>
                  {done ? 'Navigateur prêt' : 'Installation du navigateur'}
                </span>
                <button
                  onClick={() => setDismissed(true)}
                  className="p-1 rounded-md transition-colors"
                  style={{ color: 'rgba(255,255,255,0.3)' }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; e.currentTarget.style.background = 'transparent'; }}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>
                {download.status}
              </div>
            </div>
          </div>

          {/* Progress bar */}
          {!done && (
            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${download.percent}%`,
                    background: progressColor,
                    boxShadow: '0 0 12px rgba(99, 102, 241, 0.4)',
                  }}
                />
              </div>
              <span className="text-[11px] font-mono tabular-nums" style={{ color: 'rgba(255,255,255,0.5)' }}>
                {download.percent}%
              </span>
            </div>
          )}
        </div>

        {/* Bottom accent line */}
        <div
          className="h-[2px] transition-all duration-500"
          style={{
            width: done ? '100%' : `${download.percent}%`,
            background: progressColor,
          }}
        />
      </div>

      <style>{`
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-12px) scale(0.97);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
};

export default BrowserDownloadNotification;
