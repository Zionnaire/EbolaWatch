import { useState } from 'react';
import {
  useCreateOrganization,
  useOrgOverview,
  useRegenerateClaimLink,
  useSetOrgStatus,
} from '@/api/queries';
import { ApiError } from '@/api/client';
import { useToast } from '@/components/feedback/Toast';
import { OneTimeLinkDialog } from '@/components/OneTimeLinkDialog';
import {
  Callout,
  Card,
  Chip,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  SkeletonRows,
  SubmitButton,
  errorMessage,
} from '@/components/ui';
import { ORG_STATUS_LABEL, ORG_TYPE_LABEL } from '@/config/status';
import { STATE_TILES } from '@/config/stateGrid';
import type { OrganizationDto } from '@/contracts';
import { Icon } from '@/icons';
import { plural } from '@/utils/format';

type Link = { url: string; expiresAt: string };

export default function Organizations() {
  const q = useOrgOverview();
  const setStatus = useSetOrgStatus();
  const regen = useRegenerateClaimLink();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<{ title: string; intro: string; link: Link } | null>(null);
  const [confirm, setConfirm] = useState<OrganizationDto | null>(null);

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Platform"
        title="Organizations"
        lead="Each organization has its own people, reviews and responses. Everyone sees the same posts, limited to the states you give them."
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} /> New organization
          </button>
        }
      />

      {q.data && (
        <p className="muted">
          {plural(q.data.totals.organizations, 'organization')} ·{' '}
          {plural(q.data.totals.users, 'person', 'people')} · {plural(q.data.totals.reviews, 'review')}
        </p>
      )}

      <Card flush>
        {q.isPending ? (
          <div style={{ padding: 20 }}>
            <SkeletonRows rows={4} h={56} />
          </div>
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.organizations.length === 0 ? (
          <EmptyState scene="sprout" title="No organizations yet">
            Create the first one, then send its administrator the setup link.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Sees</th>
                  <th scope="col" className="num-cell">
                    People
                  </th>
                  <th scope="col" className="num-cell">
                    Reviews
                  </th>
                  <th scope="col" className="num-cell">
                    Responses
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.organizations.map(({ organization: o, users, activeUsers, reviews, narratives }) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.name}</strong>
                      <br />
                      <span className="muted small">
                        {ORG_TYPE_LABEL[o.type] ?? o.type} · {o.slug}
                      </span>
                    </td>
                    <td className="small">
                      {o.scopeStates.length === 0 ? 'All states' : plural(o.scopeStates.length, 'state')}
                    </td>
                    <td className="num-cell">
                      {activeUsers}
                      {users !== activeUsers && <span className="faint"> / {users}</span>}
                    </td>
                    <td className="num-cell">{reviews}</td>
                    <td className="num-cell">{narratives}</td>
                    <td>
                      <div className="stack stack--sm" style={{ alignItems: 'flex-start' }}>
                        <Chip tone={o.status === 'active' ? 'ok' : o.status === 'suspended' ? 'bad' : 'wait'}>
                          {ORG_STATUS_LABEL[o.status] ?? o.status}
                        </Chip>
                        {!o.adminClaimed && <Chip tone="warn">Waiting for its admin</Chip>}
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {!o.adminClaimed && (
                          <button
                            className="btn btn--ghost btn--sm"
                            disabled={regen.isPending}
                            onClick={() =>
                              regen.mutate(o.id, {
                                onSuccess: (r) =>
                                  setLink({
                                    title: 'New setup link',
                                    intro: `Send this to the person who will run ${o.name}. Earlier links stop working.`,
                                    link: r.claimLink,
                                  }),
                                onError: (e) => toast.error('Could not make a link', errorMessage(e)),
                              })
                            }
                          >
                            New setup link
                          </button>
                        )}
                        {o.status === 'suspended' ? (
                          <button
                            className="btn btn--ghost btn--sm"
                            disabled={setStatus.isPending}
                            onClick={() =>
                              setStatus.mutate(
                                { id: o.id, status: 'active' },
                                {
                                  onSuccess: () => toast.success(`${o.name} is active again`),
                                  onError: (e) => toast.error('Could not reinstate', errorMessage(e)),
                                },
                              )
                            }
                          >
                            Reinstate
                          </button>
                        ) : (
                          <button className="btn btn--ghost btn--sm" onClick={() => setConfirm(o)}>
                            Suspend
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(name, l) => {
            setCreating(false);
            setLink({
              title: `${name} is ready`,
              intro:
                'Send this setup link to the person who will run it. They become its administrator and invite everyone else.',
              link: l,
            });
          }}
        />
      )}
      {link && (
        <OneTimeLinkDialog
          title={link.title}
          intro={link.intro}
          link={link.link}
          onClose={() => setLink(null)}
        />
      )}
      {confirm && (
        <Dialog
          title={`Suspend ${confirm.name}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <SubmitButton
                className="btn btn--danger"
                pending={setStatus.isPending}
                onClick={() =>
                  setStatus.mutate(
                    { id: confirm.id, status: 'suspended' },
                    {
                      onSuccess: () => {
                        toast.warning(
                          `${confirm.name} is suspended`,
                          'Its people are signed out and cannot sign in.',
                        );
                        setConfirm(null);
                      },
                      onError: (e) => toast.error('Could not suspend', errorMessage(e)),
                    },
                  )
                }
              >
                Suspend
              </SubmitButton>
            </>
          }
        >
          <Callout tone="warn" icon="warning">
            Everyone in this organization is signed out immediately and live connections are closed. Their
            data is kept. You can reinstate them at any time.
          </Callout>
        </Dialog>
      )}
    </div>
  );
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string, link: Link) => void;
}) {
  const create = useCreateOrganization();
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState('state');
  const [region, setRegion] = useState('');
  const [states, setStates] = useState<string[]>([]);
  const fields = create.error instanceof ApiError ? create.error.fieldErrors() : {};
  const toggle = (s: string) => setStates((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]));

  return (
    <Dialog
      title="New organization"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton
            pending={create.isPending}
            disabled={name.trim().length < 2}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  type,
                  ...(region.trim() ? { region: region.trim() } : {}),
                  ...(states.length ? { scopeStates: states } : {}),
                },
                {
                  onSuccess: (r) => onCreated(r.organization.name, r.claimLink),
                  onError: (e) =>
                    !(e instanceof ApiError && e.status === 400) &&
                    toast.error('Could not create it', errorMessage(e)),
                },
              )
            }
          >
            Create
          </SubmitButton>
        </>
      }
    >
      <Field label="Name" error={fields.name}>
        {(id) => (
          <input id={id} className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <div className="grid grid--2" style={{ gap: 12 }}>
        <Field label="Kind">
          {(id) => (
            <select id={id} className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(ORG_TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Region (optional)">
          {(id) => (
            <input id={id} className="input" value={region} onChange={(e) => setRegion(e.target.value)} />
          )}
        </Field>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field__label">States it can see</legend>
        <p className="field__hint" style={{ marginBottom: 8 }}>
          Leave all unticked to see every state.{' '}
          {states.length > 0 && <strong>{plural(states.length, 'state')} chosen.</strong>}
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: 4,
            maxHeight: 190,
            overflow: 'auto',
            padding: 2,
          }}
        >
          {Object.keys(STATE_TILES)
            .sort()
            .map((s) => (
              <label key={s} className="check small">
                <input type="checkbox" checked={states.includes(s)} onChange={() => toggle(s)} />
                {s}
              </label>
            ))}
        </div>
        {fields.scopeStates && <p className="field__error">{fields.scopeStates}</p>}
      </fieldset>
    </Dialog>
  );
}
