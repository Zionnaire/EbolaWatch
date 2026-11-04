import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useClusters, usePost } from '@/api/queries';
import { Can } from '@/auth/AuthProvider';
import { AiNamed, TrendChip } from '@/components/ClusterBits';
import { GenerateDialog } from '@/components/narratives';
import { Callout, Card, Chip, EmptyState, PageHeader, QueryBoundary, SkeletonRows } from '@/components/ui';
import type { ClusterDto } from '@/contracts';
import { useNames, type Names } from '@/hooks/useNames';
import { Icon } from '@/icons';
import { formatDateTime, percent, plural } from '@/utils/format';

export default function Claims() {
  const q = useClusters(7);
  const names = useNames();
  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Watch"
        title="Recurring claims"
        lead="Flagged posts from the last seven days, grouped by the claim they make, so you can answer a rumour once instead of post by post."
      />
      <QueryBoundary
        query={q}
        skeleton={<SkeletonRows rows={4} h={150} />}
        isEmpty={(d) => d.clusters.length === 0}
        empty={
          <EmptyState scene="sprout" title="No recurring claims yet">
            When two or more flagged posts make the same claim this week, they are grouped here.
          </EmptyState>
        }
      >
        {(d) => (
          <>
            <Callout
              tone={d.method.refinement === 'ai' ? 'idle' : 'wait'}
              icon={d.method.refinement === 'ai' ? 'spark' : 'info'}
            >
              {d.note}
              {d.method.model && <> Model: {d.method.model}.</>}
              {d.unclustered > 0 && (
                <> {plural(d.unclustered, 'one-off post')} did not match any other post and are not listed.</>
              )}
            </Callout>
            <div className="stack">
              {d.clusters.map((c) => (
                <ClaimCard key={c.id} c={c} names={names} />
              ))}
            </div>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

function ClaimCard({ c, names }: { c: ClusterDto; names: Names }) {
  const [drafting, setDrafting] = useState(false);
  return (
    <Card>
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ gap: 8 }}>
            <h2 className="card__title">{c.title}</h2>
            <AiNamed c={c} />
          </div>
          {c.summary && (
            <p className="muted" style={{ marginTop: 4 }}>
              {c.summary}
            </p>
          )}
        </div>
        <div className="row" style={{ gap: 10 }}>
          <div style={{ textAlign: 'right' }}>
            <p className="num" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1 }}>
              {c.count}
            </p>
            <p className="faint small">posts · {percent(c.share)} of flagged</p>
          </div>
          <TrendChip c={c} />
        </div>
      </div>

      <div className="row" style={{ gap: 6, marginTop: 12 }}>
        {c.urgentCount > 0 && (
          <Chip tone="urgent" icon="flag">
            {c.urgentCount} urgent
          </Chip>
        )}
        {c.category && <Chip tone="plain">{names.category(c.category)}</Chip>}
        {c.languages.map((l) => (
          <Chip key={l.key} tone="plain">
            {names.language(l.key)} {l.count}
          </Chip>
        ))}
        {c.platforms.map((p) => (
          <Chip key={p.key} tone="plain">
            {names.platform(p.key)} {p.count}
          </Chip>
        ))}
        {c.topStates.map((s) => (
          <Chip key={s.key} tone="plain">
            {s.key} {s.count}
          </Chip>
        ))}
      </div>

      <p className="quote" style={{ marginTop: 14 }}>
        {c.sampleText}
      </p>
      <p className="faint small" style={{ marginTop: 6 }}>
        First seen {formatDateTime(c.firstSeen)} · latest {formatDateTime(c.lastSeen)} · {c.previousCount}{' '}
        last week
        {c.keyTerms.length > 0 && <> · key words: {c.keyTerms.join(', ')}</>}
      </p>

      <div className="row" style={{ marginTop: 14 }}>
        <Link to={`/posts/${c.samplePostId}`} className="btn btn--ghost btn--sm">
          Open the sample post
        </Link>
        <Can permission="narratives:draft">
          <button className="btn btn--sm" onClick={() => setDrafting(true)}>
            <Icon name="spark" size={16} /> Draft a response
          </button>
        </Can>
      </div>
      {drafting && <DraftForClaim postId={c.samplePostId} onClose={() => setDrafting(false)} />}
    </Card>
  );
}

/** Drafts a counter-narrative from the claim's sample post (the writer needs the post, its language and platform). */
function DraftForClaim({ postId, onClose }: { postId: string; onClose: () => void }) {
  const q = usePost(postId);
  if (!q.data) return null;
  return <GenerateDialog post={q.data.post} onClose={onClose} />;
}
