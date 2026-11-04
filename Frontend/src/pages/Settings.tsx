import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/api/client';
import { useConnectors, useKnowledge, useMyOrganization, useRules, useUpdateMySettings } from '@/api/queries';
import { changePassword } from '@/auth/api';
import { Can, useCan, useSession } from '@/auth/AuthProvider';
import { useToast } from '@/components/feedback/Toast';
import {
  Callout,
  Card,
  Chip,
  EmptyState,
  Field,
  PageHeader,
  QueryBoundary,
  SkeletonRows,
  SubmitButton,
  errorMessage,
} from '@/components/ui';
import { ORG_TYPE_LABEL } from '@/config/status';
import type { OrganizationDto, RulesConfig } from '@/contracts';
import { useNames } from '@/hooks/useNames';
import { SeverityBadge } from '@/components/ui';
import { formatDateTime, percent, prettify, timeAgo } from '@/utils/format';

export default function Settings() {
  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Oversee"
        title="Settings"
        lead="Where posts come from, how they are rated, and how your organization works."
      />
      <Can permission="org:settings">
        <OrgSettings />
      </Can>
      <Connectors />
      <Rules />
      <FactBaseCard />
      <Account />
    </div>
  );
}

function Connectors() {
  const q = useConnectors();
  const tone = (s: string) =>
    s === 'live' ? 'ok' : s === 'error' ? 'bad' : s === 'paused' ? 'warn' : 'idle';
  return (
    <Card
      title="Where posts come from"
      sub="Each connector brings posts from one platform. The status is whatever the server reports."
    >
      <QueryBoundary
        query={q}
        skeleton={<SkeletonRows rows={3} />}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState scene="signal" title="No connectors set up" />}
      >
        {(rows) => (
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((c) => (
              <li key={c.id} className="row row--between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <strong>{c.name}</strong> <span className="muted">· {prettify(c.platform)}</span>
                  {c.detail && <p className="small muted">{c.detail}</p>}
                </div>
                <div className="stack stack--sm" style={{ alignItems: 'flex-end' }}>
                  <Chip tone={tone(c.status)}>{prettify(c.status)}</Chip>
                  <span className="faint small">
                    {c.lastRunAt ? `Last run ${timeAgo(c.lastRunAt)}` : 'Has not run'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </Card>
  );
}

function FactBaseCard() {
  const q = useKnowledge();
  const [open, setOpen] = useState<string | null>(null);
  // no fact base loaded (404) is not an error worth showing
  if (q.isError) return null;
  return (
    <Card
      title="Facts the writer may use"
      sub="Counter-narratives are written only from these sources. Read-only: changes go through NCDC review."
    >
      <QueryBoundary query={q} skeleton={<SkeletonRows rows={3} />}>
        {(k) => {
          const topics = [...new Set(k.entries.map((e) => e.topic))];
          return (
            <div className="stack">
              {k.status !== 'approved' && (
                <Callout tone="warn" icon="warning">
                  <strong>Not yet approved by NCDC.</strong> {k.note}
                </Callout>
              )}
              <p className="muted small">
                {k.entries.length} facts · version {k.version} · collected {k.retrievedAt}
              </p>
              {topics.map((t) => (
                <div key={t}>
                  <h3 className="card__sub" style={{ marginBottom: 6 }}>
                    {prettify(t)}
                  </h3>
                  <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {k.entries
                      .filter((e) => e.topic === t)
                      .map((e) => (
                        <li key={e.id}>
                          <button
                            className="link-btn"
                            style={{ textAlign: 'left', textDecoration: 'none', color: 'inherit' }}
                            onClick={() => setOpen(open === e.id ? null : e.id)}
                            aria-expanded={open === e.id}
                          >
                            {e.expired && <Chip tone="bad">Expired</Chip>}{' '}
                            {e.volatile && !e.expired && <Chip tone="warn">Time-sensitive</Chip>}{' '}
                            <span className={e.expired ? 'faint' : undefined}>{e.text}</span>
                          </button>
                          {open === e.id && (
                            <p className="small muted" style={{ margin: '4px 0 0 4px' }}>
                              Source:{' '}
                              <a href={e.source.url} target="_blank" rel="noopener noreferrer">
                                {e.source.publisher}: {e.source.title}
                              </a>
                              {e.asOf && <> · as of {e.asOf}</>}
                              {e.validUntil && <> · valid until {e.validUntil}</>}
                              {e.note && <> · {e.note}</>}
                            </p>
                          )}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
              {k.gaps.length > 0 && (
                <details>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                    What is not covered yet ({k.gaps.length})
                  </summary>
                  <ul className="stack stack--sm small muted" style={{ marginTop: 8 }}>
                    {k.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        }}
      </QueryBoundary>
    </Card>
  );
}

function Rules() {
  const q = useRules();
  const [pick, setPick] = useState<string | null>(null);
  return (
    <Card
      title="How posts are rated"
      sub="Read-only. These settings turn the model’s scores into a severity and decide what reaches the queue."
    >
      <QueryBoundary
        query={q}
        skeleton={<SkeletonRows rows={4} />}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState scene="sprout" title="No rules loaded yet" />}
      >
        {(all) => {
          const current = all.find((r) => r.taxonomyVersion === pick) ?? all[0]!;
          return (
            <div className="stack">
              {all.length > 1 && (
                <Field label="Version">
                  {(id) => (
                    <select
                      id={id}
                      className="select"
                      value={current.taxonomyVersion}
                      onChange={(e) => setPick(e.target.value)}
                      style={{ maxWidth: 260 }}
                    >
                      {all.map((r) => (
                        <option key={r.taxonomyVersion} value={r.taxonomyVersion}>
                          {r.taxonomyVersion}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              <RuleSet rules={current} />
            </div>
          );
        }}
      </QueryBoundary>
    </Card>
  );
}

function RuleSet({ rules }: { rules: RulesConfig }) {
  const names = useNames(rules.taxonomyVersion);
  const cats = Object.entries(rules.categories);
  return (
    <div className="stack stack--lg">
      <dl className="kv">
        <dt>Last changed</dt>
        <dd>{formatDateTime(rules.updatedAt)}</dd>
        <dt>Flag a post when a topic scores at least</dt>
        <dd>
          {percent(rules.defaultThresholds.dormant)} normally, {percent(rules.defaultThresholds.surge)} during
          a surge
        </dd>
        <dt>Mark as urgent from</dt>
        <dd>severity {rules.urgentSeverityMin} and above</dd>
        <dt>Confidence bands</dt>
        <dd>
          urgent at {percent(rules.confidenceBands.urgent)}, standard at{' '}
          {percent(rules.confidenceBands.standard)}
        </dd>
      </dl>
      {cats.length > 0 && (
        <div className="table-wrap">
          <table className="table" style={{ fontSize: 14 }}>
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">Lowest severity</th>
                <th scope="col">Own thresholds</th>
              </tr>
            </thead>
            <tbody>
              {cats.map(([id, c]) => (
                <tr key={id}>
                  <td>{names.category(id)}</td>
                  <td>
                    <SeverityBadge level={c.floor} />
                  </td>
                  <td className="muted">
                    {c.thresholds
                      ? `${percent(c.thresholds.dormant)} / ${percent(c.thresholds.surge)}`
                      : 'Uses the defaults'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rules.keywordRules.length > 0 && (
        <div>
          <h3 className="card__sub" style={{ marginBottom: 6 }}>
            Phrases that raise the severity
          </h3>
          <ul className="stack stack--sm" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {rules.keywordRules.map((k) => (
              <li key={k.id} className="row" style={{ alignItems: 'flex-start' }}>
                <SeverityBadge level={k.severity} />
                <span>
                  {k.description ?? prettify(k.id)}
                  <br />
                  <code className="small muted">{k.pattern}</code>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function OrgSettings() {
  const q = useMyOrganization();
  const org = q.data;
  return (
    <Card
      title="Your organization"
      sub={
        org
          ? `${org.name} · ${ORG_TYPE_LABEL[org.type] ?? org.type}${org.scopeStates.length ? ` · ${org.scopeStates.join(', ')}` : ' · all states'}`
          : undefined
      }
    >
      <QueryBoundary query={q} skeleton={<SkeletonRows rows={2} />}>
        {(o) => (
          <OrgForm key={`${o.effectiveSettings.overdueHours}:${o.effectiveSettings.queueCap}`} org={o} />
        )}
      </QueryBoundary>
    </Card>
  );
}

/** Keyed on the saved values, so a save (or a change from elsewhere) resets the fields to what the server holds. */
function OrgForm({ org }: { org: OrganizationDto }) {
  const update = useUpdateMySettings();
  const toast = useToast();
  const [overdue, setOverdue] = useState(String(org.effectiveSettings.overdueHours));
  const [cap, setCap] = useState(String(org.effectiveSettings.queueCap));
  const err = update.error instanceof ApiError ? update.error.fieldErrors() : {};
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          { overdueHours: Number(overdue), queueCap: Number(cap) },
          {
            onSuccess: () => toast.success('Settings saved'),
            onError: (er) => toast.error('Could not save', errorMessage(er)),
          },
        );
      }}
    >
      <div className="grid grid--2" style={{ gap: 14 }}>
        <Field
          label="Overdue after (hours)"
          hint="A post nobody has reviewed for this long is marked overdue."
          error={err.overdueHours}
        >
          {(id, by) => (
            <input
              id={id}
              aria-describedby={by}
              className="input"
              type="number"
              min={1}
              max={720}
              value={overdue}
              onChange={(e) => setOverdue(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Queue size"
          hint="The queue shows a warning as it nears this many."
          error={err.queueCap}
        >
          {(id, by) => (
            <input
              id={id}
              aria-describedby={by}
              className="input"
              type="number"
              min={1}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          )}
        </Field>
      </div>
      <SubmitButton type="submit" pending={update.isPending} style={{ alignSelf: 'flex-start' }}>
        Save
      </SubmitButton>
    </form>
  );
}

function Account() {
  const { me } = useSession();
  const toast = useToast();
  const canSee = useCan('posts:read');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const m = useMutation({
    mutationFn: () => changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success('Password changed', 'Other devices were signed out.');
      setCurrent('');
      setNext('');
    },
    onError: (e) =>
      toast.error(
        'Could not change the password',
        e instanceof ApiError && e.code === 'wrong_password'
          ? 'The current password is not right.'
          : errorMessage(e),
      ),
  });
  if (!me || !canSee) return null;
  return (
    <Card title="Your account" sub={`${me.user.name} · ${me.user.email}`}>
      <form
        className="stack"
        style={{ maxWidth: 420 }}
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Callout tone="idle" icon="lock">
          Changing your password signs you out everywhere else.
        </Callout>
        <Field label="Current password">
          {(id) => (
            <input
              id={id}
              className="input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          {(id, by) => (
            <input
              id={id}
              aria-describedby={by}
              className="input"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </Field>
        <SubmitButton
          type="submit"
          className="btn btn--ghost"
          pending={m.isPending}
          disabled={!current || next.length < 10}
          style={{ alignSelf: 'flex-start' }}
        >
          Change password
        </SubmitButton>
      </form>
    </Card>
  );
}
