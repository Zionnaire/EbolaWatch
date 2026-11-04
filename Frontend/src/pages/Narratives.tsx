import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useNarratives } from '@/api/queries';
import { Can } from '@/auth/AuthProvider';
import { GenerateDialog, NarrativeStatusChip } from '@/components/narratives';
import { Card, Chip, EmptyState, ErrorState, PageHeader, Pager, SkeletonRows } from '@/components/ui';
import { NARRATIVE } from '@/config/status';
import type { NarrativeStatus } from '@/contracts';
import { useNames } from '@/hooks/useNames';
import { Icon } from '@/icons';
import { timeAgo } from '@/utils/format';

const TABS: Array<{ id: NarrativeStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: NARRATIVE.draft.label + 's' },
  { id: 'approved', label: NARRATIVE.approved.label },
  { id: 'dispatched', label: NARRATIVE.dispatched.label },
  { id: 'rejected', label: NARRATIVE.rejected.label },
];

export default function Narratives() {
  const [params, setParams] = useSearchParams();
  const [writing, setWriting] = useState(false);
  const names = useNames();
  const status = (params.get('status') ?? 'all') as NarrativeStatus | 'all';
  const page = Number(params.get('page') ?? '1') || 1;
  const q = useNarratives({ ...(status === 'all' ? {} : { status }), page, pageSize: 15 });

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Respond"
        title="Counter-narratives"
        lead="Clear, sourced replies to false claims. Each one is drafted, checked by a person and approved before anything is sent."
        actions={
          <Can permission="narratives:draft">
            <button className="btn" onClick={() => setWriting(true)}>
              <Icon name="plus" size={18} /> Write one by hand
            </button>
          </Can>
        }
      />
      <div className="tabs" role="tablist" aria-label="Filter by status" style={{ alignSelf: 'flex-start' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="tab"
            aria-selected={status === t.id}
            onClick={() => set('status', t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card flush>
        {q.isPending ? (
          <div style={{ padding: 20 }}>
            <SkeletonRows rows={5} h={64} />
          </div>
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState scene="sprout" title="Nothing here yet">
            Open a flagged post and choose “Draft a response”, or write one by hand.
          </EmptyState>
        ) : (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {q.data.items.map((n) => (
                <li key={n.id} style={{ borderBottom: '1px solid var(--card-edge)' }}>
                  <Link
                    to={`/narratives/${n.id}`}
                    style={{
                      display: 'block',
                      padding: '16px 22px',
                      color: 'inherit',
                      textDecoration: 'none',
                    }}
                    className="feed-item"
                  >
                    <div className="row row--between" style={{ marginBottom: 6 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <NarrativeStatusChip status={n.status} />
                        <Chip tone="plain">{names.platform(n.platform)}</Chip>
                        <Chip tone="plain">{names.language(n.language)}</Chip>
                        {n.category && <Chip tone="plain">{names.category(n.category)}</Chip>}
                        {n.isMock && <Chip tone="mock">Mock</Chip>}
                      </div>
                      <span className="faint small">{timeAgo(n.updatedAt)}</span>
                    </div>
                    <p className="post-text">{n.text}</p>
                    {n.claim && (
                      <p className="faint small post-text" style={{ marginTop: 4 }}>
                        Answering: “{n.claim}”
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            <Pager
              page={q.data.page}
              pageSize={q.data.pageSize}
              total={q.data.total}
              onPage={(n) => set('page', String(n))}
            />
          </>
        )}
      </Card>
      {writing && <GenerateDialog onClose={() => setWriting(false)} />}
    </div>
  );
}
