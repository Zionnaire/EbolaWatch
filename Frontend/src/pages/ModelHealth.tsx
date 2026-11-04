import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useModelHealth } from '@/api/queries';
import { Callout, Card, EmptyState, Field, PageHeader, QueryBoundary, SkeletonRows } from '@/components/ui';
import type { ModelHealthDto } from '@/contracts';
import { useNames, type Names } from '@/hooks/useNames';
import { percent, plural, prettify } from '@/utils/format';

const WINDOWS = [7, 30, 90];

export default function ModelHealth() {
  const [days, setDays] = useState(30);
  const q = useModelHealth(days);
  const names = useNames();

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Oversee"
        title="Model health"
        lead="How the model is doing, judged by what your analysts decided."
        actions={
          <Field label="Period">
            {(id) => (
              <select
                id={id}
                className="select"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {WINDOWS.map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </select>
            )}
          </Field>
        }
      />
      <QueryBoundary query={q} skeleton={<SkeletonRows rows={6} h={90} />}>
        {(d) => <Body d={d} names={names} />}
      </QueryBoundary>
    </div>
  );
}

function Body({ d, names }: { d: ModelHealthDto; names: Names }) {
  const r = d.reviewDerived;
  const noReviews = r.sampleSize === 0;
  return (
    <>
      <Callout tone="warn" icon="info">
        <strong>Read these numbers with care.</strong> {r.caveat}
      </Callout>

      <div className="grid grid--4">
        <Stat
          label="Reviewed posts"
          value={r.sampleSize.toLocaleString('en')}
          hint="the sample these numbers come from"
        />
        <Stat
          label="Precision"
          value={percent(r.overall.precision)}
          hint="of what it flagged, how much was right"
        />
        <Stat
          label="Recall"
          value={percent(r.overall.recall)}
          hint="of what was misinformation, how much it caught"
        />
        <Stat label="F1" value={percent(r.overall.f1)} hint="one number balancing the two" />
      </div>
      {noReviews && (
        <EmptyState scene="sprout" title="Not enough reviews yet">
          Precision and recall appear once analysts have confirmed or rejected some of the model’s flags.
        </EmptyState>
      )}

      <div className="grid grid--2">
        <Card
          title="How often analysts disagreed"
          sub={`${plural(d.overrideRate.overall.overridden, 'post')} of ${d.overrideRate.overall.reviewed.toLocaleString('en')} reviewed were rejected or corrected`}
        >
          <p className="stat__value" style={{ marginTop: 0 }}>
            {percent(d.overrideRate.overall.rate)}
          </p>
          <Rates
            title="By topic"
            rows={d.overrideRate.byClass.map((x) => ({
              key: x.key,
              name: names.category(x.key),
              a: x.overridden,
              n: x.reviewed,
              rate: x.rate,
            }))}
            verb="overridden"
          />
          <Rates
            title="By platform"
            rows={d.overrideRate.byPlatform.map((x) => ({
              key: x.key,
              name: names.platform(x.key),
              a: x.overridden,
              n: x.reviewed,
              rate: x.rate,
            }))}
            verb="overridden"
          />
        </Card>
        <Card title="Agreement by language" sub="How often analysts confirmed the model">
          <Rates
            rows={d.languageAgreement.map((x) => ({
              key: x.language,
              name: names.language(x.language),
              a: x.agreed,
              n: x.reviewed,
              rate: x.rate,
            }))}
            verb="confirmed"
          />
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title="How sure the model was" sub={d.confidence.basis}>
          {d.confidence.n === 0 ? (
            <EmptyState scene="search" title="No classifications in this period" />
          ) : (
            <div
              role="img"
              aria-label={`Histogram of model confidence across ${d.confidence.n} classifications`}
              style={{ height: 230 }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={d.confidence.bins.map((b) => ({
                    range: `${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%`,
                    count: b.count,
                  }))}
                  margin={{ top: 6, right: 6, left: -16, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} stroke="#e6d9c0" strokeDasharray="3 4" />
                  <XAxis
                    dataKey="range"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#55645f', fontSize: 11.5 }}
                    interval={0}
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#55645f', fontSize: 12 }}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(37,102,93,.08)' }}
                    contentStyle={{ borderRadius: 12, border: '1px solid #e6d9c0', background: '#fffaf0' }}
                  />
                  <Bar dataKey="count" name="Posts" fill="#25665d" radius={[5, 5, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card
          title="How fast it answers"
          sub={`Time to classify one post, across ${d.latency.n.toLocaleString('en')} posts`}
        >
          <div className="grid grid--3" style={{ gap: 12 }}>
            <Latency label="Typical" sub="p50" v={d.latency.p50} />
            <Latency label="Slow" sub="p95" v={d.latency.p95} />
            <Latency label="Slowest" sub="p99" v={d.latency.p99} />
          </div>
          {d.models.length > 0 && (
            <>
              <h3 className="card__sub" style={{ margin: '18px 0 6px' }}>
                Models that classified posts
              </h3>
              <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {d.models.map((m) => (
                  <li key={`${m.modelName}-${m.modelVersion}`} className="row row--between">
                    <span>
                      {m.modelName} <span className="muted">{m.modelVersion}</span>
                    </span>
                    <span className="num muted">{plural(m.classifications, 'post')}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      {r.perClass.length > 0 && (
        <Card title="Per topic" sub="Judged from the reviewed sample only" flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Topic</th>
                  <th scope="col" className="num-cell">
                    Flagged by model
                  </th>
                  <th scope="col" className="num-cell">
                    Actually this
                  </th>
                  <th scope="col" className="num-cell">
                    Precision
                  </th>
                  <th scope="col" className="num-cell">
                    Recall
                  </th>
                  <th scope="col" className="num-cell">
                    F1
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.perClass.map((c) => (
                  <tr key={c.id}>
                    <td>{names.category(c.id) === prettify(c.id) ? prettify(c.id) : names.category(c.id)}</td>
                    <td className="num-cell">{c.predicted}</td>
                    <td className="num-cell">{c.support}</td>
                    <td className="num-cell">{percent(c.precision)}</td>
                    <td className="num-cell">{percent(c.recall)}</td>
                    <td className="num-cell">{percent(c.f1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <section className="card">
      <p className="stat__label">{label}</p>
      <p className="stat__value">{value}</p>
      <p className="stat__hint muted">{hint}</p>
    </section>
  );
}

function Latency({ label, sub, v }: { label: string; sub: string; v: number | null }) {
  return (
    <div>
      <p className="muted small">
        {label} <span className="faint">({sub})</span>
      </p>
      <p className="num" style={{ fontSize: 28, fontWeight: 600 }}>
        {v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`}
      </p>
    </div>
  );
}

function Rates({
  title,
  rows,
  verb,
}: {
  title?: string;
  rows: Array<{ key: string; name: string; a: number; n: number; rate: number | null }>;
  verb: string;
}) {
  if (rows.length === 0) return <p className="muted small">No reviews yet.</p>;
  return (
    <div style={{ marginTop: 14 }}>
      {title && (
        <h3 className="card__sub" style={{ marginBottom: 6 }}>
          {title}
        </h3>
      )}
      <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r) => (
          <li key={r.key}>
            <div className="row row--between small">
              <span>{r.name}</span>
              <span className="muted num">
                {percent(r.rate)} · {r.a} of {r.n} {verb}
              </span>
            </div>
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${(r.rate ?? 0) * 100}%`, background: 'var(--clay)' }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
