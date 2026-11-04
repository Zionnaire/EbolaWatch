import { useMemo, useState } from 'react';
import { useGeo } from '@/api/queries';
import { download } from '@/api/client';
import { useToast } from '@/components/feedback/Toast';
import {
  Callout,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  SubmitButton,
  errorMessage,
} from '@/components/ui';
import { Cartogram, MapLegend } from '@/components/Cartogram';
import type { GeoState } from '@/contracts';
import { useNames } from '@/hooks/useNames';
import { Icon } from '@/icons';
import { plural } from '@/utils/format';

export default function Geo() {
  const q = useGeo();
  const names = useNames();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const states = q.data?.states;
  const byName = useMemo(() => new Map((states ?? []).map((s) => [s.state, s])), [states]);
  const top = useMemo(() => [...(states ?? [])].sort((a, b) => b.flagged - a.flagged)[0], [states]);
  const current = byName.get(selected ?? top?.state ?? '') ?? null;
  const surges = (states ?? []).filter((s) => s.surge);

  const exportCsv = async () => {
    setBusy(true);
    try {
      await download('/api/analytics/geo', { format: 'csv' });
    } catch (e) {
      toast.error('Could not download the file', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Last 7 days"
        title="Geography"
        lead="Every state is one tile, so small states are as easy to see as large ones. Darker means more flagged posts."
        actions={
          <SubmitButton className="btn btn--ghost" pending={busy} onClick={() => void exportCsv()}>
            <Icon name="download" size={18} /> Download CSV
          </SubmitButton>
        }
      />

      {q.isPending ? (
        <div className="grid grid--main">
          <Skeleton h={520} r={22} />
          <Skeleton h={520} r={22} />
        </div>
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {surges.length > 0 && (
            <Callout tone="warn" icon="warning">
              <strong>{plural(surges.length, 'state')} surging:</strong>{' '}
              {surges.map((s) => s.state).join(', ')}. A surge is more than +{q.data.surgeThresholdPct}%
              flagged posts compared with last week, with at least {q.data.minCount} posts.
            </Callout>
          )}
          <div className="grid grid--main">
            <Card
              title="Flagged posts by state"
              sub={`${q.data.totals.flagged.toLocaleString('en')} flagged of ${q.data.totals.total.toLocaleString('en')} posts`}
            >
              {q.data.totals.total === 0 ? (
                <EmptyState scene="search" title="No located posts this week" />
              ) : (
                <>
                  <Cartogram
                    states={q.data.states}
                    selected={current?.state ?? null}
                    onSelect={setSelected}
                  />
                  <div style={{ marginTop: 10 }}>
                    <MapLegend />
                  </div>
                </>
              )}
              {q.data.unlocated.total > 0 && (
                <p className="faint small" style={{ marginTop: 10 }}>
                  {plural(q.data.unlocated.total, 'post')} ({q.data.unlocated.flagged} flagged) had no
                  recognisable state and are not on the map.
                </p>
              )}
            </Card>

            {current && <StateDetail s={current} names={names} />}
          </div>

          <Card title="All states" sub="The same numbers as the map, as a table" flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">State</th>
                    <th scope="col" className="num-cell">
                      Flagged
                    </th>
                    <th scope="col" className="num-cell">
                      Last week
                    </th>
                    <th scope="col">Change</th>
                    <th scope="col">Main platform</th>
                    <th scope="col">Main language</th>
                  </tr>
                </thead>
                <tbody>
                  {[...q.data.states]
                    .sort((a, b) => b.flagged - a.flagged || a.state.localeCompare(b.state))
                    .map((s) => (
                      <tr
                        key={s.state}
                        className="is-link"
                        onClick={() => setSelected(s.state)}
                        aria-selected={current?.state === s.state}
                      >
                        <td>
                          <strong>{s.state}</strong>
                        </td>
                        <td className="num-cell">{s.flagged}</td>
                        <td className="num-cell">{s.previousFlagged}</td>
                        <td>
                          <Change s={s} />
                        </td>
                        <td>{s.dominantPlatform ? names.platform(s.dominantPlatform) : '—'}</td>
                        <td>{s.dominantLanguage ? names.language(s.dominantLanguage) : '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Change({
  s,
}: {
  s: Pick<GeoState, 'surge' | 'changePct' | 'newActivity' | 'flagged' | 'previousFlagged'>;
}) {
  if (s.surge)
    return (
      <Chip tone="bad" icon="arrowUp">
        Surge{s.changePct !== null ? ` +${Math.round(s.changePct)}%` : ' (new)'}
      </Chip>
    );
  if (s.newActivity) return <Chip tone="warn">New this week</Chip>;
  if (s.changePct === null) return <span className="faint">—</span>;
  const up = s.changePct > 0;
  return (
    <Chip tone={up ? 'warn' : 'ok'} icon={up ? 'arrowUp' : 'arrowDown'}>
      {up ? '+' : ''}
      {Math.round(s.changePct)}%
    </Chip>
  );
}

function StateDetail({ s, names }: { s: GeoState; names: ReturnType<typeof useNames> }) {
  return (
    <Card
      title={s.state}
      sub={`${plural(s.flagged, 'flagged post')} of ${plural(s.total, 'post')} this week`}
      actions={<Change s={s} />}
    >
      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Main platform</dt>
        <dd>{s.dominantPlatform ? names.platform(s.dominantPlatform) : '—'}</dd>
        <dt>Main language</dt>
        <dd>{s.dominantLanguage ? names.language(s.dominantLanguage) : '—'}</dd>
        <dt>Last week</dt>
        <dd>{plural(s.previousFlagged, 'flagged post')}</dd>
      </dl>
      <h3 className="card__sub" style={{ marginBottom: 6 }}>
        What is being said
      </h3>
      {s.topCategories.length === 0 ? (
        <p className="muted small">Nothing flagged here this week.</p>
      ) : (
        <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {s.topCategories.map((c) => (
            <li key={c.id} className="row row--between">
              <span>{names.category(c.id)}</span>
              <span className="num muted">{c.count}</span>
            </li>
          ))}
        </ul>
      )}
      {s.lgas.length > 0 && (
        <>
          <h3 className="card__sub" style={{ margin: '18px 0 6px' }}>
            Local government areas
          </h3>
          <div className="table-wrap">
            <table className="table" style={{ fontSize: 13.5 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ padding: '8px 10px' }}>
                    LGA
                  </th>
                  <th scope="col" className="num-cell" style={{ padding: '8px 10px' }}>
                    Flagged
                  </th>
                  <th scope="col" style={{ padding: '8px 10px' }}>
                    Change
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.lgas.map((l) => (
                  <tr key={l.lga}>
                    <td style={{ padding: '8px 10px' }}>{l.lga}</td>
                    <td className="num-cell" style={{ padding: '8px 10px' }}>
                      {l.flagged}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <Change s={l} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
