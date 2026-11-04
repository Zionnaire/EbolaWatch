import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '@/api/client';
import { Icon, type IconName } from '@/icons';
import { Scene } from '@/illustrations';
import { SEVERITY, type SeverityGlyph } from '@/config/severity';
import type { Tone } from '@/config/status';
import type { SeverityLevel } from '@/contracts';

/* ---------- severity ---------- */

function Glyph({ shape, size = 14 }: { shape: SeverityGlyph; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true as const };
  switch (shape) {
    case 'ring':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case 'dot':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4.5" fill="currentColor" />
        </svg>
      );
    case 'triangle':
      return (
        <svg {...common}>
          <path
            d="M8 2.200 14.200 13H1.800Z"
            fill="currentColor"
            strokeLinejoin="round"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      );
    case 'diamond':
      return (
        <svg {...common}>
          <path d="M8 1.500 14.500 8 8 14.500 1.500 8Z" fill="currentColor" />
        </svg>
      );
    case 'burst':
      return (
        <svg {...common}>
          <path
            d="m8 0.800 1.800 3.300 3.600-1 -1 3.600 3.300 1.800-3.300 1.800 1 3.600-3.600-1L8 15.200l-1.800-3.300-3.600 1 1-3.600L.3 8l3.300-1.800-1-3.600 3.600 1Z"
            fill="currentColor"
          />
        </svg>
      );
  }
}

/** Severity is the glyph shape plus the word: never colour alone. */
export function SeverityBadge({
  level,
  compact,
}: {
  level: SeverityLevel | null | undefined;
  compact?: boolean;
}) {
  if (level === null || level === undefined) {
    return <span className="chip chip--plain">Not flagged</span>;
  }
  const s = SEVERITY[level];
  return (
    <span
      className="sev"
      style={{ '--sev-color': s.color, '--sev-tint': s.tint } as CSSProperties}
      title={s.meaning}
    >
      <Glyph shape={s.glyph} />
      {compact ? `${level}` : `${s.label}`}
      {compact && <span className="sr-only"> {s.label}</span>}
    </span>
  );
}

/* ---------- chips ---------- */

export function Chip({
  tone = 'idle',
  icon,
  children,
  title,
}: {
  tone?: Tone | 'done' | 'plain' | 'mock' | 'overdue' | 'urgent';
  icon?: IconName;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip ${tone === 'idle' ? '' : `chip--${tone}`}`} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

/* ---------- structure ---------- */

export function PageHeader({
  title,
  lead,
  eyebrow,
  actions,
}: {
  title: string;
  lead?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page__head">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="page__title">{title}</h1>
        {lead && <p className="page__lead">{lead}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  sub,
  actions,
  children,
  className = '',
  flush,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card ${flush ? 'card--flush' : ''} ${className}`}>
      {(title || actions) && (
        <div className="card__head" style={flush ? { padding: '18px 22px 0' } : undefined}>
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {sub && <p className="card__sub">{sub}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 5, h = 44 }: { rows?: number; h?: number }) {
  return (
    <div className="stack--sm stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={h} />
      ))}
    </div>
  );
}

export function EmptyState({
  scene = 'inbox',
  title,
  children,
  action,
}: {
  scene?: Parameters<typeof Scene>[0]['kind'];
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Scene kind={scene} />
      <p className="empty__title">{title}</p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Words for an API problem a person can act on. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to do that.';
    if (err.status === 404)
      return 'That could not be found. It may have been removed, or it belongs to another organization.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="empty" role="alert">
      <Scene kind="signal" />
      <p className="empty__title">That did not load</p>
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button className="btn btn--ghost btn--sm" onClick={onRetry}>
          <Icon name="refresh" size={16} /> Try again
        </button>
      )}
    </div>
  );
}

/**
 * Loading, error and empty for every query, in one place so no page forgets one of them.
 * `isEmpty` decides whether the data counts as empty; the page supplies the wording.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  isEmpty,
  empty,
  children,
}: {
  query: UseQueryResult<T>;
  skeleton?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <SkeletonRows />}</>;
  if (query.isError && !query.data)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}

export function Callout({
  tone = 'idle',
  icon = 'info',
  children,
}: {
  tone?: 'idle' | 'wait' | 'warn' | 'bad' | 'ok';
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div
      className={`callout ${tone === 'idle' ? '' : `callout--${tone}`}`}
      role={tone === 'bad' ? 'alert' : undefined}
    >
      <Icon name={icon} size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Pagination">
      <span>
        {from}–{to} of {total.toLocaleString('en')}
      </span>
      <div className="row">
        <button className="btn btn--ghost btn--sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <Icon name="chevronLeft" size={16} /> Previous
        </button>
        <span aria-live="polite">
          Page {page} of {pages}
        </span>
        <button className="btn btn--ghost btn--sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next <Icon name="chevronRight" size={16} />
        </button>
      </div>
    </nav>
  );
}

/* ---------- forms ---------- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  htmlFor?: string;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id, describedBy)}
      {error ? (
        <p className="field__error" id={`${id}-err`}>
          {error}
        </p>
      ) : (
        hint && (
          <p className="field__hint" id={`${id}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/* ---------- dialog ---------- */

export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.dialog__x)')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => !el.hasAttribute('disabled'));
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="row row--between" style={{ marginBottom: 14 }}>
          <h2 id={titleId} className="card__title">
            {title}
          </h2>
          <button className="btn btn--quiet btn--icon dialog__x" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="stack">{children}</div>
        {footer && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Spinner() {
  return <Icon name="refresh" size={16} style={{ animation: 'spin 0.9s linear infinite' }} />;
}

/** Disables itself and shows a spinner while its action is running. */
export function SubmitButton({
  pending,
  children,
  className = 'btn',
  ...rest
}: {
  pending?: boolean;
  children: ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={className} disabled={pending || rest.disabled} {...rest}>
      {pending && <Spinner />}
      {children}
    </button>
  );
}
