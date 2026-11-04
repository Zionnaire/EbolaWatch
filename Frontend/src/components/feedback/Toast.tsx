import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from '@/icons';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export interface ToastInput {
  title: string;
  body?: string;
  kind?: ToastKind;
  /** ms; 0 keeps it until dismissed. Errors stay longer by default. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}
interface ToastItem extends ToastInput {
  id: number;
  kind: ToastKind;
}

interface Api {
  show: (t: ToastInput) => number;
  success: (title: string, body?: string) => number;
  info: (title: string, body?: string) => number;
  warning: (title: string, body?: string) => number;
  error: (title: string, body?: string) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<Api | null>(null);
const ICONS: Record<ToastKind, IconName> = {
  success: 'check',
  info: 'info',
  warning: 'warning',
  error: 'alert',
};
const LABEL: Record<ToastKind, string> = {
  success: 'Done',
  info: 'Note',
  warning: 'Heads up',
  error: 'Problem',
};
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = next.current++;
    setItems((l) => [...l, { ...t, id, kind: t.kind ?? 'info' }].slice(-MAX_VISIBLE));
    return id;
  }, []);

  const api = useMemo<Api>(
    () => ({
      show,
      dismiss,
      success: (title, body) => show({ title, body, kind: 'success' }),
      info: (title, body) => show({ title, body, kind: 'info' }),
      warning: (title, body) => show({ title, body, kind: 'warning', duration: 9000 }),
      error: (title, body) => show({ title, body, kind: 'error', duration: 10_000 }),
    }),
    [show, dismiss],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {items.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const duration = toast.duration ?? 5000;
  useEffect(() => {
    if (!duration || paused) return;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [duration, paused, onClose]);

  return (
    <div
      className={`toast toast--${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast__mark" aria-hidden="true">
        <Icon name={ICONS[toast.kind]} size={18} />
      </span>
      <div className="toast__text">
        <p className="toast__title">
          <span className="sr-only">{LABEL[toast.kind]}: </span>
          {toast.title}
        </p>
        {toast.body && <p className="toast__body">{toast.body}</p>}
        {toast.action && (
          <button
            className="toast__action"
            onClick={() => {
              toast.action?.onClick();
              onClose();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button className="toast__close" onClick={onClose} aria-label="Dismiss notification">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

export function useToast(): Api {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside <ToastProvider>');
  return v;
}
