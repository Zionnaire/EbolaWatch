import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useBreakdown, useClusters, useGeo, usePosts, useSummary, useTimeseries } from '@/api/queries';
import { useSession } from '@/auth/AuthProvider';
import { StackedDays } from '@/components/charts/StackedDays';
import { Cartogram, MapLegend } from '@/components/Cartogram';
import { AiNamed, TrendChip } from '@/components/ClusterBits';
import { PostFlags, PostLabel, PostRating } from '@/components/PostBits';
import {
  Callout,
  Card,
  Chip,
  EmptyState,
  PageHeader,
  QueryBoundary,
  Skeleton,
  SkeletonRows,
} from '@/components/ui';
import type { BreakdownDto, PostDto } from '@/contracts';
import { useNames } from '@/hooks/useNames';
import { CardLeaves } from '@/illustrations';
import { LIVE_FEED_KEY } from '@/sockets/useLiveSync';
import { plural, timeAgo } from '@/utils/format';

const todayLabel = () =>
  new Intl.DateTimeFormat('en-NG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Africa/Lagos',
  }).format(new Date());

export default function Dashboard() {
  const { me } = useSession();
  const summary = useSummary();
  const names = useNames();

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow={todayLabel()}
        title={`Hello, ${me?.user.name.split(' ')[0] ?? 'there'}`}
        lead="Here is what the platform has picked up in the last day and week."
      />

      <div className="grid grid--4">
        <QueryBoundary query={summary} skeleton={<StatSkeletons />}>
          {(s) => (
            <>
              <section className="card card--hero" aria-labelledby="stat-today">
                <CardLeaves />
                <div className="card__body">
                  <p className="stat__label" id="stat-today">
                    Posts today
                  </p>
                  <p className="stat__value">{s.postsToday.toLocaleString('en')}</p>
                  <p className="stat__hint">picked up since midnight, Lagos time</p>
                </div>
              </section>
              <section className="card card--blush" aria-labelledby="stat-flagged">
                <CardLeaves tone="blush" />
                <div className="card__body">
                  <p className="stat__label" id="stat-flagged">
                    Flagged this week
                  </p>
                  <p className="stat__value">{s.flagged7d.toLocaleString('en')}</p>
                  <p className="stat__hint">likely misinformation, last 7 days</p>
                </div>
              </section>
              <section className="card" aria-labelledby="stat-queue">
                <p className="stat__label" id="stat-queue">
                  Waiting for review
                </p>
                <p className="stat__value">{s.queue.review.toLocaleString('en')}</p>
                <div className="bar" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.min(100, (s.queue.review / Math.max(1, s.queue.cap)) * 100)}%`,
                      background: s.queue.warning === 'none' ? undefined : 'var(--clay)',
                    }}
                  />
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="small muted">of {s.queue.cap.toLocaleString('en')} slots</span>
                  {s.queue.warning === 'approaching' && (
                    <Chip tone="warn" icon="warning">
                      Filling up
                    </Chip>
                  )}
                  {s.queue.warning === 'full' && (
                    <Chip tone="bad" icon="alert">
                      Queue full
                    </Chip>
                  )}
                  {s.queue.overdue > 0 && (
                    <Chip tone="overdue" icon="clock">
                      {s.queue.overdue} overdue
                    </Chip>
                  )}
                </div>
              </section>
              <section className="card" aria-labelledby="stat-sent">
                <p className="stat__label" id="stat-sent">
                  Responses sent today
                </p>
                <p className="stat__value">{s.dispatchedToday.toLocaleString('en')}</p>
                <p className="stat__hint muted">{plural(s.queue.informationGap, 'information gap')} open</p>
              </section>
            </>
          )}
        </QueryBoundary>
      </div>

      {summary.data &&
        (summary.data.pipeline.classificationError > 0 || summary.data.pipeline.needsReview > 0) && (
          <Callout tone="warn" icon="warning">
            {summary.data.pipeline.classificationError > 0 && (
              <>{plural(summary.data.pipeline.classificationError, 'post')} could not be classified. </>
            )}
            {summary.data.pipeline.needsReview > 0 && (
              <>
                {plural(summary.data.pipeline.needsReview, 'post')} need a closer look because the model
                returned something unfamiliar.{' '}
              </>
            )}
            <Link to="/queue">Open the queue</Link>
          </Callout>
        )}

      <div className="grid grid--main">
        <div className="stack stack--lg">
          <Card title="The last seven days" sub="Posts per day, split by what the model found">
            <WeekChart names={names} />
          </Card>
          <SurgeMapCard />
        </div>
        <LiveFeed />
      </div>

      <div className="grid grid--2">
        <Card title="Where it is being said" sub="Last 7 days. The dark part of each bar is flagged posts.">
          <BreakdownCard names={names} />
        </Card>
        <Card title="Recurring claims" sub="Posts that make the same claim, grouped together">
          <ClustersCard names={names} />
        </Card>
      </div>
    </div>
  );
}

function StatSkeletons() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card">
          <Skeleton h={14} w="55%" />
          <div style={{ height: 14 }} />
          <Skeleton h={40} w="40%" />
        </div>
      ))}
    </>
  );
}

function WeekChart({ names }: { names: ReturnType<typeof useNames> }) {
  const q = useTimeseries(7);
  return (
    <QueryBoundary
      query={q}
      skeleton={<Skeleton h={280} />}
      isEmpty={(d) => d.totals.every((t) => t === 0)}
      empty={
        <EmptyState scene="sprout" title="Nothing yet this week">
          Posts will appear here as they are picked up.
        </EmptyState>
      }
    >
      {(d) => <StackedDays data={d} names={names} />}
    </QueryBoundary>
  );
}

function LiveFeed() {
  const navigate = useNavigate();
  const names = useNames();
  // the socket keeps this list current; the first paint comes from the newest posts the server has
  const recent = usePosts({ pageSize: 8 });
  const live = useQuery<PostDto[]>({
    queryKey: LIVE_FEED_KEY,
    queryFn: () => [],
    staleTime: Infinity,
    initialData: [],
  });
  const merged = [
    ...(live.data ?? []),
    ...(recent.data?.items ?? []).filter((p) => !live.data?.some((l) => l.id === p.id)),
  ].slice(0, 8);

  return (
    <Card
      title="Just classified"
      sub="Updates as posts come in"
      actions={
        <span className="chip chip--ok">
          <span className="dot dot--pulse" />
          Live
        </span>
      }
    >
      {recent.isPending ? (
        <SkeletonRows rows={5} h={52} />
      ) : merged.length === 0 ? (
        <EmptyState scene="inbox" title="No posts yet">
          New posts show up here the moment they are classified.
        </EmptyState>
      ) : (
        <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {merged.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => navigate(`/posts/${p.id}`)}
                style={{
                  all: 'unset',
                  display: 'block',
                  width: '100%',
                  boxSizing: 'border-box',
                  cursor: 'pointer',
                  padding: '9px 10px',
                  borderRadius: 12,
                }}
                className="feed-item"
              >
                <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                  <PostRating post={p} />
                  <PostFlags post={p} />
                  <span className="faint small right">{timeAgo(p.ingestedAt)}</span>
                </div>
                <p className="post-text small">{p.text}</p>
                <p className="faint small" style={{ marginTop: 2 }}>
                  <PostLabel post={p} names={names} /> · {names.platform(p.platform)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BreakdownCard({ names }: { names: ReturnType<typeof useNames> }) {
  const q = useBreakdown(7);
  return (
    <QueryBoundary
      query={q}
      isEmpty={(d) => d.total === 0}
      empty={<EmptyState scene="search" title="No posts in this window" />}
    >
      {(d) => (
        <div className="stack">
          <BarList title="Platform" rows={d.platform} name={names.platform} />
          <BarList title="Language" rows={d.language} name={(k) => names.language(k)} />
        </div>
      )}
    </QueryBoundary>
  );
}

function BarList({
  title,
  rows,
  name,
}: {
  title: string;
  rows: BreakdownDto['platform'];
  name: (k: string) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div>
      <h3 style={{ fontSize: 14, marginBottom: 8 }} className="muted">
        {title}
      </h3>
      <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.slice(0, 6).map((r) => (
          <li key={r.key}>
            <div className="row row--between small">
              <span>{name(r.key)}</span>
              <span className="muted num">
                {r.flagged.toLocaleString('en')} / {r.total.toLocaleString('en')}
              </span>
            </div>
            <div className="bar" aria-hidden="true" style={{ position: 'relative' }}>
              <span
                style={{
                  width: `${(r.total / max) * 100}%`,
                  background: 'var(--card-edge)',
                  position: 'absolute',
                  inset: 0,
                }}
              />
              <span
                style={{
                  width: `${(r.flagged / max) * 100}%`,
                  background: 'var(--clay)',
                  position: 'absolute',
                  inset: 0,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClustersCard({ names }: { names: ReturnType<typeof useNames> }) {
  const q = useClusters(7);
  return (
    <QueryBoundary
      query={q}
      isEmpty={(d) => d.clusters.length === 0}
      empty={
        <EmptyState scene="sprout" title="No recurring claims yet">
          When several posts make the same claim, they are grouped here.
        </EmptyState>
      }
    >
      {(d) => (
        <div className="stack">
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {d.clusters.slice(0, 4).map((c) => (
              <li key={c.id}>
                <div className="row row--between" style={{ alignItems: 'flex-start' }}>
                  <strong style={{ flex: 1, minWidth: 0 }}>{c.title}</strong>
                  <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <span className="num" title="posts this week">
                      {c.count}
                    </span>
                    <TrendChip c={c} />
                  </span>
                </div>
                {c.summary && <p className="small muted">{c.summary}</p>}
                <div className="row small faint" style={{ gap: 6, marginTop: 2 }}>
                  {c.category && <span>{names.category(c.category)}</span>}
                  {c.languages.slice(0, 3).map((l) => (
                    <span key={l.key}>· {names.language(l.key)}</span>
                  ))}
                  <AiNamed c={c} />
                </div>
              </li>
            ))}
          </ul>
          <div className="row row--between small">
            <span className="faint">
              {d.unclustered > 0 ? `${plural(d.unclustered, 'one-off post')} not grouped. ` : ''}
            </span>
            <Link to="/claims">See all {d.clusters.length}</Link>
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}

/** The map the user asked for under the chart: where flagged posts are, and which states are surging. */
function SurgeMapCard() {
  const navigate = useNavigate();
  const q = useGeo();
  return (
    <Card
      title="Where it is rising"
      sub="Flagged posts by state this week. A triangle marks a surge."
      actions={
        <Link to="/geo" className="small">
          Open full map
        </Link>
      }
    >
      <QueryBoundary
        query={q}
        skeleton={<Skeleton h={260} />}
        isEmpty={(d) => d.totals.flagged === 0}
        empty={
          <EmptyState scene="search" title="Nothing flagged on the map">
            States will light up as flagged posts come in.
          </EmptyState>
        }
      >
        {(d) => {
          const ranked = [...d.states]
            .filter((s) => s.flagged > 0)
            .sort((a, b) => Number(b.surge) - Number(a.surge) || b.flagged - a.flagged);
          return (
            <div className="map-split">
              <div>
                <Cartogram states={d.states} onSelect={() => navigate('/geo')} compact />
                <div style={{ marginTop: 8 }}>
                  <MapLegend />
                </div>
              </div>
              <div className="stack stack--sm">
                <h3 className="card__sub">Busiest states</h3>
                <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {ranked.slice(0, 6).map((s) => (
                    <li key={s.state} className="row row--between">
                      <span>
                        <strong>{s.state}</strong>
                        <span className="faint small"> · {plural(s.flagged, 'post')}</span>
                      </span>
                      {s.surge ? (
                        <Chip tone="bad" icon="arrowUp">
                          Surge
                        </Chip>
                      ) : s.newActivity ? (
                        <Chip tone="warn">New</Chip>
                      ) : s.changePct !== null ? (
                        <Chip
                          tone={s.changePct > 0 ? 'warn' : 'ok'}
                          icon={s.changePct > 0 ? 'arrowUp' : 'arrowDown'}
                        >
                          {Math.abs(Math.round(s.changePct))}%
                        </Chip>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {d.unlocated.total > 0 && (
                  <p className="faint small">
                    {plural(d.unlocated.total, 'post')} had no recognisable state.
                  </p>
                )}
              </div>
            </div>
          );
        }}
      </QueryBoundary>
    </Card>
  );
}
