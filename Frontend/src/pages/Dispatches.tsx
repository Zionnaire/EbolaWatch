import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDispatches } from '@/api/queries';
import { Card, Chip, EmptyState, ErrorState, PageHeader, Pager, SkeletonRows } from '@/components/ui';
import { useNames } from '@/hooks/useNames';
import { formatDateTime } from '@/utils/format';

export default function Dispatches() {
  const [page, setPage] = useState(1);
  const q = useDispatches({ page, pageSize: 15 });
  const names = useNames();

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Respond"
        title="Dispatch console"
        lead="Everything that was sent, exactly as it was sent, with the post it answered."
      />
      <Card flush>
        {q.isPending ? (
          <div style={{ padding: 20 }}>
            <SkeletonRows rows={5} h={64} />
          </div>
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState scene="inbox" title="Nothing has been sent yet">
            Approved counter-narratives appear here once someone sends them.
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap" aria-busy={q.isFetching}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Sent</th>
                    <th scope="col">Original post</th>
                    <th scope="col">What was sent</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((d) => (
                    <tr key={d.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {formatDateTime(d.createdAt)}
                        <br />
                        <span className="faint small">{names.platform(d.platform)}</span>
                      </td>
                      <td>
                        {d.originalPost ? (
                          <>
                            <Link
                              to={`/posts/${d.originalPost.id}`}
                              className="post-text"
                              style={{ color: 'inherit', textDecoration: 'none' }}
                            >
                              {d.originalPost.text}
                            </Link>
                            {d.originalPost.state && (
                              <span className="faint small">{d.originalPost.state}</span>
                            )}
                          </>
                        ) : (
                          <span className="faint">Written by hand, not in answer to a post</span>
                        )}
                      </td>
                      <td>
                        <Link
                          to={`/narratives/${d.narrativeId}`}
                          className="post-text"
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {d.text}
                        </Link>
                      </td>
                      <td>
                        <div className="stack stack--sm" style={{ alignItems: 'flex-start' }}>
                          <Chip
                            tone={d.status === 'sent' ? 'ok' : 'bad'}
                            icon={d.status === 'sent' ? 'check' : 'alert'}
                          >
                            {d.status === 'sent' ? 'Sent' : 'Failed'}
                          </Chip>
                          {d.isMock && <Chip tone="mock">Mock</Chip>}
                          {d.error && <span className="small muted">{d.error}</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
