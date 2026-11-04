import { Link, useParams } from 'react-router-dom';
import { usePost } from '@/api/queries';
import { Can, useCan, useSession } from '@/auth/AuthProvider';
import { ScoreBars } from '@/components/charts/ScoreBars';
import { PostNarratives } from '@/components/narratives';
import { PostFlags, PostRating } from '@/components/PostBits';
import { ReviewForm } from '@/components/ReviewForm';
import { Callout, Card, Chip, EmptyState, ErrorState, SeverityBadge, Skeleton } from '@/components/ui';
import { PIPELINE, REVIEW, label } from '@/config/status';
import { SEVERITY, SEVERITY_LEVELS } from '@/config/severity';
import type { Classification, DecisionDto, PostDetailDto } from '@/contracts';
import { useNames, type Names } from '@/hooks/useNames';
import { Icon } from '@/icons';
import { formatDateTime, percent, prettify } from '@/utils/format';

export default function PostDetail() {
  const { id } = useParams();
  const q = usePost(id);

  if (q.isPending)
    return (
      <div className="stack">
        <Skeleton h={34} w="40%" />
        <Skeleton h={160} />
        <Skeleton h={260} />
      </div>
    );
  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <Detail d={q.data} />;
}

function Detail({ d }: { d: PostDetailDto }) {
  const { post, history, reviews } = d;
  const c = post.classification;
  const names = useNames(c?.taxonomyVersion);
  const canReview = useCan('posts:review');
  const { me } = useSession();

  return (
    <div className="stack stack--lg">
      <div>
        <Link
          to={post.decision?.queue === 'information_gap' ? '/gaps' : '/queue'}
          className="row small"
          style={{ textDecoration: 'none', gap: 4 }}
        >
          <Icon name="chevronLeft" size={16} /> Back to the queue
        </Link>
        <div className="page__head" style={{ marginTop: 10, marginBottom: 0 }}>
          <div>
            <p className="eyebrow">{names.platform(post.platform)} post</p>
            <h1 className="page__title">Post review</h1>
          </div>
          <div className="row">
            <PostRating post={post} />
            <PostFlags post={post} />
            <Chip tone={post.reviewStatus === 'unreviewed' ? 'idle' : 'done'}>
              {REVIEW[post.reviewStatus]}
            </Chip>
          </div>
        </div>
      </div>

      <div className="grid grid--main">
        <div className="stack stack--lg">
          <Card title="What was said" sub="Personal details were removed before this was saved.">
            <p className="quote">{post.text}</p>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>Platform</dt>
              <dd>{names.platform(post.platform)}</dd>
              <dt>Language</dt>
              <dd>{names.language(c?.language ?? post.languageHint)}</dd>
              <dt>Place</dt>
              <dd>{post.state ? `${post.state}${post.lga ? `, ${post.lga}` : ''}` : 'Not given'}</dd>
              <dt>Posted</dt>
              <dd>{formatDateTime(post.postedAt)}</dd>
              <dt>Picked up</dt>
              <dd>{formatDateTime(post.ingestedAt)}</dd>
              {post.engagement && (
                <>
                  <dt>Reach</dt>
                  <dd>
                    {[
                      post.engagement.views != null && `${post.engagement.views.toLocaleString('en')} views`,
                      post.engagement.likes != null && `${post.engagement.likes.toLocaleString('en')} likes`,
                      post.engagement.reposts != null &&
                        `${post.engagement.reposts.toLocaleString('en')} shares`,
                      post.engagement.replies != null &&
                        `${post.engagement.replies.toLocaleString('en')} replies`,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </dd>
                </>
              )}
            </dl>
          </Card>

          {post.errorDetail && (
            <Callout tone="bad" icon="alert">
              {label(PIPELINE, post.pipelineStatus)}: {post.errorDetail}
            </Callout>
          )}

          {c ? (
            <Card
              title="What the model found"
              sub={`${c.modelName} ${c.modelVersion}${post.isMock ? ' · mock data' : ''}`}
            >
              <Findings c={c} names={names} />
            </Card>
          ) : (
            <Card title="What the model found">
              <EmptyState scene="sprout" title={label(PIPELINE, post.pipelineStatus)}>
                {post.pipelineStatus === 'classification_error'
                  ? 'It will be retried when the model is available.'
                  : 'The result will appear here as soon as it is ready.'}
              </EmptyState>
            </Card>
          )}

          {post.decision && <Reasoning decision={post.decision} />}
          {history.length > 1 && <History history={history} names={names} />}
        </div>

        <div className="stack stack--lg">
          {!canReview && (
            <Callout tone="wait" icon="info">
              <strong>Reviewing and responding is done by a team member.</strong>{' '}
              {me?.user.role === 'super_admin'
                ? 'You are signed in as the platform operator, who manages organizations but does not work on posts. Sign in with an organization account (analyst, senior analyst, supervisor or organization admin) to review this post or draft a counter-narrative.'
                : 'Your role can read posts but not review them.'}
            </Callout>
          )}
          {c && canReview && (
            <Card title="Your review" sub="The model suggests. You decide.">
              {post.reviewStatus !== 'unreviewed' && (
                <div style={{ marginBottom: 14 }}>
                  <Callout tone="ok" icon="check">
                    Your team already marked this <strong>{REVIEW[post.reviewStatus].toLowerCase()}</strong>.
                    You can review it again if something changed.
                  </Callout>
                </div>
              )}
              <ReviewForm postId={post.id} classification={c} names={names} />
            </Card>
          )}
          {reviews.length > 0 && (
            <Card title="Review history">
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {reviews.map((r) => (
                  <li key={r.id}>
                    <div className="row row--between">
                      <Chip
                        tone={r.decision === 'confirmed' ? 'ok' : r.decision === 'rejected' ? 'bad' : 'warn'}
                      >
                        {prettify(r.decision)}
                      </Chip>
                      <span className="faint small">{formatDateTime(r.createdAt)}</span>
                    </div>
                    {r.correction && (
                      <p className="small" style={{ marginTop: 4 }}>
                        Changed to: {r.correction.labels.map((l) => names.category(l)).join(', ')}
                      </p>
                    )}
                    {r.note && (
                      <p className="small muted" style={{ marginTop: 2 }}>
                        “{r.note}”
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Can permission="narratives:read">
            <Card title="Counter-narratives" sub="Responses prepared for this post">
              <PostNarratives post={post} />
            </Card>
          </Can>
        </div>
      </div>
    </div>
  );
}

function Findings({ c, names }: { c: Classification; names: Names }) {
  const topId = [...c.categories].sort((a, b) => b.score - a.score)[0]?.label;
  return (
    <div className="stack stack--lg">
      {!c.isRelevant && (
        <Callout tone="idle" icon="info">
          The model thinks this post is not about Ebola ({percent(c.relevanceConfidence)} sure).
        </Callout>
      )}
      {c.truncated && (
        <Callout tone="warn" icon="warning">
          The post was long, so the model only read the first part of it.
        </Callout>
      )}

      {c.threeClass ? (
        <div>
          <h3 className="card__sub" style={{ marginBottom: 8 }}>
            How likely each answer is
          </h3>
          <ScoreBars
            label="Probability of each class"
            rows={Object.entries(c.threeClass.probabilities).map(([id, score]) => ({
              id,
              name: prettify(id),
              score,
              active: id === c.threeClass?.label,
            }))}
          />
          <p className="small muted" style={{ marginTop: 8 }}>
            Model’s answer: <strong>{prettify(c.threeClass.label)}</strong>. Uncertainty (entropy){' '}
            {c.threeClass.entropy.toFixed(2)}: the higher it is, the less sure the model is.
          </p>
        </div>
      ) : (
        <div>
          <h3 className="card__sub" style={{ marginBottom: 8 }}>
            How well each topic fits
          </h3>
          <ScoreBars
            label="Category scores"
            rows={c.categories.map((x) => ({
              id: x.label,
              name: names.category(x.label),
              score: x.score,
              active: x.label === topId,
            }))}
          />
        </div>
      )}

      <dl className="kv">
        {c.stance && (
          <>
            <dt>Stance</dt>
            <dd>{names.stance(c.stance)}</dd>
          </>
        )}
        <dt>Relevant to Ebola</dt>
        <dd>
          {c.isRelevant ? 'Yes' : 'No'} ({percent(c.relevanceConfidence)})
        </dd>
        <dt>Language</dt>
        <dd>{names.language(c.language)}</dd>
        <dt>Time taken</dt>
        <dd>{Math.round(c.latencyMs)} ms</dd>
      </dl>

      {c.severity && (
        <div>
          <h3 className="card__sub" style={{ marginBottom: 8 }}>
            How serious the model thinks it is (confidence {percent(c.severity.confidence)})
          </h3>
          <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {SEVERITY_LEVELS.map((l) => {
              const p = c.severity?.distribution[l] ?? 0;
              return (
                <li key={l} className="row" style={{ flexWrap: 'nowrap' }}>
                  <span style={{ width: 120, flex: 'none' }}>
                    <SeverityBadge level={l} />
                  </span>
                  <div className="bar" style={{ flex: 1 }} aria-hidden="true">
                    <span style={{ width: `${p * 100}%`, background: SEVERITY[l].color }} />
                  </div>
                  <span className="num small" style={{ width: 44, textAlign: 'right' }}>
                    {percent(p)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Reasoning({ decision }: { decision: DecisionDto }) {
  const entries = Object.entries(decision.rulesSnapshot);
  return (
    <Card title="Why it was rated this way" sub="From the settings that were in force when it was classified">
      <div className="row" style={{ marginBottom: 12 }}>
        <SeverityBadge level={decision.finalSeverity} />
        {decision.urgent && (
          <Chip tone="urgent" icon="flag">
            Urgent
          </Chip>
        )}
        <Chip tone="plain">Priority {decision.priorityScore.toFixed(2)}</Chip>
        {decision.needsReview && <Chip tone="warn">Unfamiliar label seen</Chip>}
      </div>
      {decision.reasons.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 20 }} className="stack stack--sm">
          {decision.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No special rule applied.</p>
      )}
      {entries.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Settings used</summary>
          <dl className="kv" style={{ marginTop: 10 }}>
            {entries.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{prettify(k)}</dt>
                <dd className="small" style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
                  {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </Card>
  );
}

function History({ history, names }: { history: PostDetailDto['history']; names: Names }) {
  return (
    <Card title="Earlier readings" sub="The same post, as different model versions saw it">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Model</th>
              <th scope="col">Result</th>
              <th scope="col">Rating</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => {
              const top = h.classification.threeClass
                ? prettify(h.classification.threeClass.label)
                : [...h.classification.categories].sort((a, b) => b.score - a.score)[0];
              return (
                <tr key={h.classificationId}>
                  <td className="muted">
                    {formatDateTime(h.createdAt)}
                    {i === 0 && (
                      <>
                        {' '}
                        <Chip tone="done">Current</Chip>
                      </>
                    )}
                  </td>
                  <td>
                    {h.classification.modelName} {h.classification.modelVersion}
                    {h.isMock && (
                      <>
                        {' '}
                        <Chip tone="mock">Mock</Chip>
                      </>
                    )}
                  </td>
                  <td>
                    {typeof top === 'string'
                      ? top
                      : top
                        ? `${names.category(top.label)} (${percent(top.score)})`
                        : '—'}
                  </td>
                  <td>
                    <SeverityBadge level={h.decision?.finalSeverity} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
