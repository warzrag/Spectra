import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  /** Whether the exit animation is playing */
  exiting: boolean;
}

interface ToastContextValue {
  showToast: (message: string, type: ToastType) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
};

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 3000;
const ERROR_DURATION = 5000;
const EXIT_ANIMATION_MS = 250;

const typeStyles: Record<
  ToastType,
  {
    color: string;
    background: string;
    border: string;
    icon: React.FC<{ size?: number; style?: React.CSSProperties }>;
  }
> = {
  success: {
    color: 'var(--success)',
    background: 'var(--success-subtle)',
    border: 'var(--success)',
    icon: CheckCircle,
  },
  error: {
    color: 'var(--danger)',
    background: 'var(--danger-subtle)',
    border: 'var(--danger)',
    icon: XCircle,
  },
  info: {
    color: 'var(--accent)',
    background: 'var(--accent-subtle)',
    border: 'var(--accent)',
    icon: Info,
  },
  warning: {
    color: 'var(--warning)',
    background: 'var(--warning-subtle)',
    border: 'var(--warning)',
    icon: AlertTriangle,
  },
};

// ---------------------------------------------------------------------------
// Keyframe injection (runs once)
// ---------------------------------------------------------------------------

let stylesInjected = false;

function injectKeyframes(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const css = `
@keyframes toast-slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
@keyframes toast-slide-out {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(100%);
  }
}`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// ToastItem
// ---------------------------------------------------------------------------

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

const ToastItem: React.FC<ToastItemProps> = ({ toast, onDismiss }) => {
  const { color, background, border, icon: Icon } = typeStyles[toast.type];

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '12px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    lineHeight: '1.45',
    background,
    border: `1px solid ${border}`,
    color: 'var(--text-primary)',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
    pointerEvents: 'auto' as const,
    minWidth: '280px',
    maxWidth: '380px',
    animation: toast.exiting
      ? `toast-slide-out ${EXIT_ANIMATION_MS}ms ease-in forwards`
      : `toast-slide-in 250ms ease-out forwards`,
  };

  const iconStyle: React.CSSProperties = {
    color,
    flexShrink: 0,
    marginTop: '1px',
  };

  const closeStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px',
    borderRadius: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: '1px',
    transition: 'color 0.15s ease',
  };

  return (
    <div style={containerStyle}>
      <Icon size={16} style={iconStyle} />
      <span style={{ flex: 1, wordBreak: 'break-word' }}>{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        style={closeStyle}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color =
            'var(--text-primary)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color =
            'var(--text-muted)';
        }}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ToastContainer
// ---------------------------------------------------------------------------

const ToastContainer: React.FC<{ toasts: Toast[]; onDismiss: (id: string) => void }> = ({
  toasts,
  onDismiss,
}) => {
  if (toasts.length === 0) return null;

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    pointerEvents: 'none',
  };

  return (
    <div style={containerStyle}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ToastProvider
// ---------------------------------------------------------------------------

let nextId = 0;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Inject CSS keyframes on first mount
  useEffect(() => {
    injectKeyframes();
  }, []);

  // Clean up all timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    // Clear any pending timer for this toast
    const existing = timersRef.current.get(id);
    if (existing) {
      clearTimeout(existing);
      timersRef.current.delete(id);
    }

    // Start exit animation
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    );

    // Remove from DOM after animation completes
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_ANIMATION_MS);
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType) => {
      const id = `toast-${++nextId}`;
      const duration = type === 'error' ? ERROR_DURATION : DEFAULT_DURATION;

      setToasts((prev) => {
        let updated = [...prev, { id, message, type, exiting: false }];

        // Enforce max visible: dismiss oldest (non-exiting) if over limit
        const visible = updated.filter((t) => !t.exiting);
        if (visible.length > MAX_VISIBLE) {
          const oldest = visible[0];
          // Mark it as exiting immediately
          updated = updated.map((t) =>
            t.id === oldest.id ? { ...t, exiting: true } : t,
          );
          // Schedule its removal
          setTimeout(() => {
            setToasts((p) => p.filter((t) => t.id !== oldest.id));
          }, EXIT_ANIMATION_MS);
          // Clear its auto-dismiss timer
          const oldTimer = timersRef.current.get(oldest.id);
          if (oldTimer) {
            clearTimeout(oldTimer);
            timersRef.current.delete(oldest.id);
          }
        }

        return updated;
      });

      // Schedule auto-dismiss
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        removeToast(id);
      }, duration);
      timersRef.current.set(id, timer);
    },
    [removeToast],
  );

  const value: ToastContextValue = { showToast };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
};

export default ToastContext;
