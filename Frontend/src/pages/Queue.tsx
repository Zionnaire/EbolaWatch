import { useNavigate, useSearchParams } from 'react-router-dom';
import { useBreakdown, usePosts, type PostFilters } from '@/api/queries';
import { PostFlags, PostLabel, PostRating } from '@/components/PostBits';
import { Card, EmptyState, ErrorState, Field, PageHeader, Pager, SkeletonRows } from '@/components/ui';
import { SEVERITY, SEVERITY_LEVELS } from '@/config/severity';
import type { Queue as QueueName, ReviewStatus } from '@/contracts';
import { useNames } from '@/hooks/useNames';
import { timeAgo } from '@/utils/format';

const PAGE_SIZE = 20;

interface Props {
  queue: Extract<QueueName, 'review' | 'information_gap'>;
}

/** The review queue and the information-gaps queue are the same list over a different `queue` filter. */
export default function QueuePage({ queue }: Props) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const names = useNames();
  const breakdown = useBreakdown(30);

  const page = Number(params.get('page') ?? '1') || 1;
  const severity = params.get('severity');
  const category = params.get('category');
  const language = params.get('language');
  const platform = params.get('platform');
  const scope = (params.get('show') ?? 'open') as 'open' | 'all';

  const filters: PostFilters = {
    queue,
    page,
    pageSize: PAGE_SIZE,
    ...(scope === 'open' ? { reviewStatus: 'unreviewed' as ReviewStatus } : {}),
    ...(severity ? { severity: Number(severity) } : {}),
    ...(category ? { category } : {}),
    ...(language ? { language } : {}),
    ...(platform ? { platform } : {}),
  };
  const q = usePosts(filters);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const anyFilter = !!(severity || category || language || platform);
  const isGaps = queue === 'information_gap';

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow={isGaps ? 'Questions without answers' : 'Needs a person'}
        title={isGaps ? 'Information gaps' : 'Review queue'}
        lead={
          isGaps
            ? 'Posts where people are asking questions and no clear answer is in sight. A good counter-narrative here can get ahead of a rumour.'
            : 'Posts the model flagged, most pressing first. Open one to read it in full, check the model’s reasoning and confirm, reject or correct it.'
        }
      />

      <Card>
        <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
          <Field label="Show">
            {(id) => (
              <select
                id={id}
                className="select"
                value={scope}
                onChange={(e) => set('show', e.target.value === 'open' ? '' : e.target.value)}
              >
                <option value="open">Not yet reviewed</option>
                <option value="all">Everything</option>
              </select>
            )}
          </Field>
          <Field label="Severity">
            {(id) => (
              <select
                id={id}
                className="select"
                value={severity ?? ''}
                onChange={(e) => set('severity', e.target.value)}
              >
                <option value="">Any</option>
                {(names.taxonomy?.severityLevels ?? SEVERITY_LEVELS).map((l) => (
                  <option key={l} value={l}>
                    {l} · {SEVERITY[l as 0 | 1 | 2 | 3 | 4]?.label ?? l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Category">
            {(id) => (
              <select
                id={id}
                className="select"
                value={category ?? ''}
                onChange={(e) => set('category', e.target.value)}
              >
                <option value="">Any</option>
                {names.taxonomy?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Language">
            {(id) => (
              <select
                id={id}
                className="select"
                value={language ?? ''}
                onChange={(e) => set('language', e.target.value)}
              >
                <option value="">Any</option>
                {names.taxonomy?.languages.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.displayName}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Platform">
            {(id) => (
              <select
                id={id}
                className="select"
                value={platform ?? ''}
                onChange={(e) => set('platform', e.target.value)}
              >
                <option value="">Any</option>
                {breakdown.data?.platform.map((p) => (
                  <option key={p.key} value={p.key}>
                    {names.platform(p.key)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {anyFilter && (
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() =>
                setParams(new URLSearchParams(scope === 'all' ? { show: 'all' } : {}), { replace: true })
              }
            >
              Clear filters
            </button>
          )}
        </form>
      </Card>

      <Card flush>
        {q.isPending ? (
          <div style={{ padding: 20 }}>
            <SkeletonRows rows={6} h={52} />
          </div>
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState
            scene={anyFilter ? 'search' : 'inbox'}
            title={
              anyFilter
                ? 'Nothing matches those filters'
                : isGaps
                  ? 'No open information gaps'
                  : 'The queue is clear'
            }
          >
            {anyFilter ? 'Try removing a filter.' : 'New flagged posts will appear here as they come in.'}
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap" aria-busy={q.isFetching}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <th scope="col">Post</th>
                    <th scope="col">About</th>
                    <th scope="col">Language</th>
                    <th scope="col">Platform</th>
                    <th scope="col">Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((p) => (
                    <tr key={p.id} className="is-link" onClick={() => navigate(`/posts/${p.id}`)}>
                      <td>
                        <div className="stack stack--sm" style={{ alignItems: 'flex-start' }}>
                          <PostRating post={p} />
                          <div className="row" style={{ gap: 4 }}>
                            <PostFlags post={p} />
                          </div>
                        </div>
                      </td>
                      <td>
                        <a
                          href={`/posts/${p.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            navigate(`/posts/${p.id}`);
                          }}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          <span className="post-text">{p.text}</span>
                        </a>
                        {p.state && (
                          <span className="faint small">
                            {p.state}
                            {p.lga ? `, ${p.lga}` : ''}
                          </span>
                        )}
                      </td>
                      <td>
                        <PostLabel post={p} names={names} />
                      </td>
                      <td>{names.language(p.classification?.language ?? p.languageHint)}</td>
                      <td>{names.platform(p.platform)}</td>
                      <td
                        className="muted"
                        style={{ whiteSpace: 'nowrap' }}
                        title={new Date(p.postedAt).toLocaleString('en-NG')}
                      >
                        {timeAgo(p.ingestedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={q.data.page}
              pageSize={q.data.pageSize}
              total={q.data.total}
              onPage={(n) => set('page', String(n))}
            />
          </>
        )}
      </Card>
    </div>
  );
}
