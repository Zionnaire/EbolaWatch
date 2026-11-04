import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from '@/auth/AuthProvider';
import { EmptyState, SkeletonRows } from '@/components/ui';
import { AppShell } from '@/layouts/AppShell';
import { Link } from 'react-router-dom';

// Pages are split so the chart library only loads when a chart page is opened.
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const QueuePage = lazy(() => import('@/pages/Queue'));
const PostDetail = lazy(() => import('@/pages/PostDetail'));
const Narratives = lazy(() => import('@/pages/Narratives'));
const NarrativeDetail = lazy(() => import('@/pages/NarrativeDetail'));
const Dispatches = lazy(() => import('@/pages/Dispatches'));
const Geo = lazy(() => import('@/pages/Geo'));
const Claims = lazy(() => import('@/pages/Claims'));
const ModelHealth = lazy(() => import('@/pages/ModelHealth'));
const Settings = lazy(() => import('@/pages/Settings'));
const Team = lazy(() => import('@/pages/Team'));
const Organizations = lazy(() => import('@/pages/Organizations'));
const Login = lazy(() => import('@/pages/auth/Login'));
const Claim = lazy(() => import('@/pages/auth/Claim'));
const Invite = lazy(() => import('@/pages/auth/Invite'));

function Splash() {
  return (
    <div style={{ padding: 48, maxWidth: 520, margin: '12vh auto' }}>
      <SkeletonRows rows={3} h={28} />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();
  if (state === 'loading') return <Splash />;
  if (state === 'signedOut')
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Route-level permission check. The server enforces the same rule; this only avoids showing a dead end. */
function Needs({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useSession();
  if (can(permission)) return <>{children}</>;
  return (
    <EmptyState scene="lost" title="This area is not part of your role">
      Ask an administrator of your organization if you need access.
      <br />
      <Link to="/">Back to overview</Link>
    </EmptyState>
  );
}

function NotFound() {
  return (
    <EmptyState scene="lost" title="We could not find that page">
      <Link to="/">Go to the overview</Link>
    </EmptyState>
  );
}

function Home() {
  const { can } = useSession();
  // every role can read analytics today, but keep the fallback honest
  return can('analytics:read') ? <Dashboard /> : <Navigate to="/queue" replace />;
}

export default function App() {
  return (
    <Suspense fallback={<Splash />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/claim-org/:token" element={<Claim />} />
        <Route path="/accept-invite/:token" element={<Invite />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Home />} />
          <Route
            path="queue"
            element={
              <Needs permission="posts:read">
                <QueuePage queue="review" />
              </Needs>
            }
          />
          <Route
            path="gaps"
            element={
              <Needs permission="posts:read">
                <QueuePage queue="information_gap" />
              </Needs>
            }
          />
          <Route
            path="posts/:id"
            element={
              <Needs permission="posts:read">
                <PostDetail />
              </Needs>
            }
          />
          <Route
            path="narratives"
            element={
              <Needs permission="narratives:read">
                <Narratives />
              </Needs>
            }
          />
          <Route
            path="narratives/:id"
            element={
              <Needs permission="narratives:read">
                <NarrativeDetail />
              </Needs>
            }
          />
          <Route
            path="dispatches"
            element={
              <Needs permission="narratives:read">
                <Dispatches />
              </Needs>
            }
          />
          <Route
            path="geo"
            element={
              <Needs permission="analytics:read">
                <Geo />
              </Needs>
            }
          />
          <Route
            path="claims"
            element={
              <Needs permission="analytics:read">
                <Claims />
              </Needs>
            }
          />
          <Route
            path="model-health"
            element={
              <Needs permission="analytics:read">
                <ModelHealth />
              </Needs>
            }
          />
          <Route
            path="settings"
            element={
              <Needs permission="platform:read">
                <Settings />
              </Needs>
            }
          />
          <Route
            path="team"
            element={
              <Needs permission="users:manage">
                <Team />
              </Needs>
            }
          />
          <Route
            path="organizations"
            element={
              <Needs permission="orgs:manage">
                <Organizations />
              </Needs>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
