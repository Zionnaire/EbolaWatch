import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSummary, useSystemStatus } from '@/api/queries';
import { useSession } from '@/auth/AuthProvider';
import { MockBanner, StatusBar } from '@/components/StatusBar';
import { ROLE_LABEL, ORG_TYPE_LABEL } from '@/config/status';
import { Icon, type IconName } from '@/icons';
import { BrandMark, SidebarGarden } from '@/illustrations';
import { useLiveSync } from '@/sockets/useLiveSync';

interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  permission: string;
  end?: boolean;
  /** Hidden when the model contract has no information-gap queue. */
  needsMultilabel?: boolean;
  badge?: 'queue';
}

const GROUPS: Array<{ label: string; items: NavEntry[] }> = [
  {
    label: 'Watch',
    items: [
      { to: '/', label: 'Overview', icon: 'overview', permission: 'analytics:read', end: true },
      { to: '/queue', label: 'Review queue', icon: 'queue', permission: 'posts:read', badge: 'queue' },
      {
        to: '/gaps',
        label: 'Information gaps',
        icon: 'gap',
        permission: 'posts:read',
        needsMultilabel: true,
      },
      { to: '/claims', label: 'Recurring claims', icon: 'narrative', permission: 'analytics:read' },
      { to: '/geo', label: 'Geography', icon: 'geo', permission: 'analytics:read' },
    ],
  },
  {
    label: 'Respond',
    items: [
      { to: '/narratives', label: 'Counter-narratives', icon: 'narrative', permission: 'narratives:read' },
      { to: '/dispatches', label: 'Dispatch console', icon: 'dispatch', permission: 'narratives:read' },
    ],
  },
  {
    label: 'Oversee',
    items: [
      { to: '/model-health', label: 'Model health', icon: 'health', permission: 'analytics:read' },
      { to: '/settings', label: 'Settings', icon: 'settings', permission: 'platform:read' },
      { to: '/team', label: 'Team', icon: 'users', permission: 'users:manage' },
      { to: '/organizations', label: 'Organizations', icon: 'org', permission: 'orgs:manage' },
    ],
  },
];

export function AppShell() {
  const { me, can, signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const status = useSystemStatus();
  const summary = useSummary();

  useLiveSync((id) => navigate(`/posts/${id}`));

  if (!me) return null;
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const multilabel = status.data?.modelContract !== 'threeclass-v0';

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'is-open' : ''}`} aria-label="Main">
        <a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          <BrandMark />
          <span>
            <span className="brand__name">EbolaWatch</span>
            <br />
            <span className="brand__sub">Nigeria</span>
          </span>
        </a>

        {me.organization && (
          <div className="org-chip">
            <strong>{me.organization.name}</strong>
            <span>
              {ORG_TYPE_LABEL[me.organization.type] ?? me.organization.type}
              {me.organization.scopeStates.length > 0 &&
                ` · ${me.organization.scopeStates.length} state${me.organization.scopeStates.length === 1 ? '' : 's'}`}
            </span>
          </div>
        )}

        <nav className="nav">
          {GROUPS.map((g) => {
            const items = g.items.filter((i) => can(i.permission) && (!i.needsMultilabel || multilabel));
            if (items.length === 0) return null;
            return (
              <div key={g.label} style={{ display: 'contents' }}>
                <p className="nav__label">{g.label}</p>
                {items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    end={i.end}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) => `nav__item ${isActive ? 'is-active' : ''}`}
                  >
                    <Icon name={i.icon} size={20} />
                    {i.label}
                    {i.badge === 'queue' && (summary.data?.queue.review ?? 0) > 0 && (
                      <span className="nav__count" aria-label={`${summary.data?.queue.review} waiting`}>
                        {summary.data?.queue.review}
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <SidebarGarden />
        <div className="sidebar__foot">
          <div className="userbox">
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
            <div style={{ minWidth: 0 }}>
              <p className="userbox__name" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {me.user.name}
              </p>
              <p className="userbox__role">{ROLE_LABEL[me.user.role] ?? me.user.role}</p>
            </div>
            <button
              className="btn btn--quiet btn--icon"
              onClick={() => void signOut().then(() => navigate('/login'))}
              title="Sign out"
              aria-label="Sign out"
              style={{ color: 'var(--on-forest)' }}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      <div className="main">
        <header className="topbar">
          <button
            className="btn btn--quiet btn--icon menu-btn"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Icon name="menu" size={22} />
          </button>
          <StatusBar />
        </header>
        <MockBanner />
        <main className="page" id="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
