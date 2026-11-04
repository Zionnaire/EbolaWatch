import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useDispatchNarrative,
  useEditNarrative,
  useNarrative,
  useNarrativeConfig,
  useNarrativeDecision,
  useRegenerateNarrative,
} from '@/api/queries';
import { Can, useCan } from '@/auth/AuthProvider';
import { useToast } from '@/components/feedback/Toast';
import { NarrativeStatusChip } from '@/components/narratives';
import {
  Callout,
  Card,
  Chip,
  Dialog,
  ErrorState,
  Field,
  Skeleton,
  SubmitButton,
  errorMessage,
} from '@/components/ui';
import type { NarrativeDetailDto } from '@/contracts';
import { useNames } from '@/hooks/useNames';
import { Icon } from '@/icons';
import { formatDateTime } from '@/utils/format';

export default function NarrativeDetail() {
  const { id } = useParams();
  const q = useNarrative(id);
  if (q.isPending)
    return (
      <div className="stack">
        <Skeleton h={34} w="35%" />
        <Skeleton h={300} />
      </div>
    );
  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  // keyed on the server's version: a regeneration or an edit saved elsewhere resets the editor to the new text
  return <Editor key={`${q.data.narrative.id}:${q.data.narrative.updatedAt}`} d={q.data} />;
}

type Dialogs = null | 'approve' | 'reject' | 'regenerate' | 'dispatch';

function Editor({ d }: { d: NarrativeDetailDto }) {
  const { narrative: n, reviews, dispatch } = d;
  const names = useNames(n.taxonomyVersion);
  const edit = useEditNarrative(n.id);
  const toast = useToast();
  const canDraft = useCan('narratives:draft');
  const canApprove = useCan('narratives:approve');
  const canDispatch = useCan('narratives:dispatch');
  const [text, setText] = useState(n.text);
  const [dialog, setDialog] = useState<Dialogs>(null);

  const dirty = text.trim() !== n.text;
  const locked = n.status === 'dispatching' || n.status === 'dispatched';
  const over = text.length > n.charLimit;

  return (
    <div className="stack stack--lg">
      <div>
        <Link to="/narratives" className="row small" style={{ textDecoration: 'none', gap: 4 }}>
          <Icon name="chevronLeft" size={16} /> All counter-narratives
        </Link>
        <div className="page__head" style={{ marginTop: 10, marginBottom: 0 }}>
          <div>
            <p className="eyebrow">
              {names.platform(n.platform)} · {names.language(n.language)}
            </p>
            <h1 className="page__title">Counter-narrative</h1>
          </div>
          <div className="row">
            <NarrativeStatusChip status={n.status} />
            {n.isMock && <Chip tone="mock">Mock</Chip>}
          </div>
        </div>
      </div>

      <div className="grid grid--main">
        <div className="stack stack--lg">
          {n.claim && (
            <Card title="The claim being answered">
              <p className="quote">{n.claim}</p>
              {n.postId && (
                <p style={{ marginTop: 10 }}>
                  <Link to={`/posts/${n.postId}`}>Open the original post</Link>
                </p>
              )}
            </Card>
          )}

          <Card
            title="The reply"
            sub={
              n.generator.mode === 'mock'
                ? 'Written by the mock writer: a template, not real model output.'
                : `Drafted by AI (${n.generator.name}) from the NCDC and WHO fact base. Read every line against the sources before approving.`
            }
          >
            {n.warnings.length > 0 && (
              <div className="stack stack--sm" style={{ marginBottom: 12 }}>
                {n.warnings.map((w) => (
                  <Callout key={w} tone="warn" icon="warning">
                    {w}
                  </Callout>
                ))}
              </div>
            )}
            <Field
              label="Text"
              hint={
                locked ? 'This reply is being sent or was sent, so it can no longer be changed.' : undefined
              }
            >
              {(id, by) => (
                <textarea
                  id={id}
                  aria-describedby={by}
                  className="textarea"
                  style={{ minHeight: 190 }}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  readOnly={locked || !canDraft}
                />
              )}
            </Field>
            <div className="row row--between" style={{ marginTop: 8 }}>
              <span className={`small ${over ? 'field__error' : 'muted'}`} aria-live="polite">
                {text.length} / {n.charLimit} characters{over && ' · too long for this platform'}
              </span>
              {canDraft && !locked && (
                <div className="row">
                  {dirty && (
                    <button className="btn btn--quiet btn--sm" onClick={() => setText(n.text)}>
                      <Icon name="undo" size={16} /> Discard changes
                    </button>
                  )}
                  <SubmitButton
                    className="btn btn--sm"
                    pending={edit.isPending}
                    disabled={!dirty || !text.trim() || over}
                    onClick={() =>
                      edit.mutate(text.trim(), {
                        onSuccess: () =>
                          toast.success(
                            'Saved',
                            n.status === 'approved'
                              ? 'Editing removes the approval. It needs approving again.'
                              : undefined,
                          ),
                        onError: (e) => toast.error('Could not save', errorMessage(e)),
                      })
                    }
                  >
                    Save changes
                  </SubmitButton>
                </div>
              )}
            </div>
          </Card>

          {n.citations.length > 0 && (
            <Card title="Sources">
              <ul className="stack stack--sm" style={{ margin: 0, paddingLeft: 18 }}>
                {n.citations.map((c) => (
                  <li key={c.url}>
                    <a href={c.url} target="_blank" rel="noopener noreferrer">
                      {c.title}
                    </a>{' '}
                    <span className="muted small">· {c.source}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {dispatch && (
            <Card title="Sent" sub={formatDateTime(dispatch.createdAt)}>
              <Callout
                tone={dispatch.status === 'sent' ? 'ok' : 'bad'}
                icon={dispatch.status === 'sent' ? 'check' : 'alert'}
              >
                {dispatch.status === 'sent' ? (
                  <>
                    Sent to {names.platform(dispatch.platform)} by the{' '}
                    {dispatch.dispatcher.mode === 'mock'
                      ? 'mock dispatcher (nothing was actually posted)'
                      : 'dispatcher'}
                    .
                    {dispatch.externalId && (
                      <>
                        {' '}
                        Reference <code>{dispatch.externalId}</code>.
                      </>
                    )}
                  </>
                ) : (
                  <>It could not be sent: {dispatch.error ?? 'unknown error'}</>
                )}
              </Callout>
            </Card>
          )}
        </div>

        <div className="stack stack--lg">
          <Card title="Where it stands">
            <Steps status={n.status} approved={!!n.approval} />
            {n.approval && (
              <p className="small muted" style={{ marginTop: 10 }}>
                Approved {formatDateTime(n.approval.at)}
                {n.approval.note && <> · “{n.approval.note}”</>}
              </p>
            )}
            {!n.approval && n.status === 'approved' && (
              <Callout tone="warn" icon="warning">
                The text changed after it was approved. It needs approving again.
              </Callout>
            )}

            <div className="stack stack--sm" style={{ marginTop: 16 }}>
              {canApprove && !locked && (
                <>
                  <button
                    className="btn"
                    onClick={() => setDialog('approve')}
                    disabled={dirty || over || (n.status === 'approved' && !!n.approval)}
                  >
                    <Icon name="check" size={18} /> Approve this text
                  </button>
                  <button
                    className="btn btn--ghost"
                    onClick={() => setDialog('reject')}
                    disabled={n.status === 'rejected'}
                  >
                    Reject
                  </button>
                </>
              )}
              {canDraft && !locked && (
                <button className="btn btn--ghost" onClick={() => setDialog('regenerate')}>
                  <Icon name="refresh" size={18} /> Write it again
                </button>
              )}
              {canDispatch && n.status === 'approved' && n.approval && (
                <button className="btn btn--danger" onClick={() => setDialog('dispatch')} disabled={dirty}>
                  <Icon name="dispatch" size={18} /> Send it
                </button>
              )}
              {dirty && !locked && (
                <p className="small muted">Save your changes before approving or sending.</p>
              )}
              <Can
                permission="narratives:approve"
                fallback={
                  <p className="small muted">
                    Approving and sending is done by a senior analyst or supervisor.
                  </p>
                }
              >
                {null}
              </Can>
            </div>
          </Card>

          {reviews.length > 0 && (
            <Card title="Decisions">
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {reviews.map((r) => (
                  <li key={r.id}>
                    <div className="row row--between">
                      <Chip tone={r.decision === 'approved' ? 'ok' : 'bad'}>
                        {r.decision === 'approved' ? 'Approved' : 'Rejected'}
                      </Chip>
                      <span className="faint small">{formatDateTime(r.createdAt)}</span>
                    </div>
                    {!r.onCurrentText && <p className="small faint">On an earlier version of the text</p>}
                    {r.note && <p className="small muted">“{r.note}”</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {n.versions.length > 1 && (
            <Card title="Versions">
              <ol className="stack stack--sm" style={{ margin: 0, paddingLeft: 18 }}>
                {[...n.versions].reverse().map((v, i) => (
                  <li key={`${v.at}-${i}`} className="small">
                    <strong>
                      {v.kind === 'generated' ? 'Written' : v.kind === 'edited' ? 'Edited' : 'Written again'}
                    </strong>{' '}
                    · {formatDateTime(v.at)}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      </div>

      {dialog === 'approve' && <DecisionDialog id={n.id} action="approve" onClose={() => setDialog(null)} />}
      {dialog === 'reject' && <DecisionDialog id={n.id} action="reject" onClose={() => setDialog(null)} />}
      {dialog === 'regenerate' && <RegenerateDialog d={d} onClose={() => setDialog(null)} />}
      {dialog === 'dispatch' && <DispatchDialog d={d} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Steps({
  status,
  approved,
}: {
  status: NarrativeDetailDto['narrative']['status'];
  approved: boolean;
}) {
  const rank =
    status === 'dispatched' || status === 'dispatching' ? 2 : status === 'approved' && approved ? 1 : 0;
  const steps = ['Drafted', 'Approved', 'Sent'];
  return (
    <ol
      className="row"
      style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6, flexWrap: 'nowrap' }}
      aria-label="Progress"
    >
      {steps.map((s, i) => (
        <li key={s} style={{ flex: 1 }} aria-current={i === rank ? 'step' : undefined}>
          <div className="bar" aria-hidden="true">
            <span
              style={{
                width: i <= rank ? '100%' : 0,
                background: status === 'rejected' && i === 0 ? 'var(--clay)' : undefined,
              }}
            />
          </div>
          <span
            className={`small ${i <= rank ? '' : 'faint'}`}
            style={{ fontWeight: i === rank ? 700 : 500 }}
          >
            {s}
            {i <= rank && <span className="sr-only"> (done)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function DecisionDialog({
  id,
  action,
  onClose,
}: {
  id: string;
  action: 'approve' | 'reject';
  onClose: () => void;
}) {
  const m = useNarrativeDecision(id, action);
  const toast = useToast();
  const [note, setNote] = useState('');
  const approve = action === 'approve';
  return (
    <Dialog
      title={approve ? 'Approve this text' : 'Reject this text'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton
            pending={m.isPending}
            className={approve ? 'btn' : 'btn btn--danger'}
            onClick={() =>
              m.mutate(note.trim() || undefined, {
                onSuccess: () => {
                  toast.success(
                    approve ? 'Approved' : 'Rejected',
                    approve ? 'It can now be sent by someone with permission to send.' : undefined,
                  );
                  onClose();
                },
                onError: (e) => toast.error('Could not save your decision', errorMessage(e)),
              })
            }
          >
            {approve ? 'Approve' : 'Reject'}
          </SubmitButton>
        </>
      }
    >
      <p className="muted">
        {approve
          ? 'You are saying this exact wording is accurate, clear and safe to publish.'
          : 'It will not be sent. You can still write it again.'}
      </p>
      <Field label="Note (optional)">
        {(id2) => (
          <textarea
            id={id2}
            className="textarea"
            style={{ minHeight: 80 }}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

function RegenerateDialog({ d, onClose }: { d: NarrativeDetailDto; onClose: () => void }) {
  const n = d.narrative;
  const names = useNames(n.taxonomyVersion);
  const config = useNarrativeConfig();
  const m = useRegenerateNarrative(n.id);
  const toast = useToast();
  const [category, setCategory] = useState(n.category ?? '');
  const [language, setLanguage] = useState('');
  const [guidance, setGuidance] = useState('');
  return (
    <Dialog
      title="Write it again"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton
            pending={m.isPending}
            onClick={() =>
              m.mutate(
                {
                  ...(category && category !== n.category ? { category } : {}),
                  ...(language ? { language: language as 'en' } : {}),
                  ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
                },
                {
                  onSuccess: () => {
                    toast.success('New draft ready', 'Earlier approvals no longer apply.');
                    onClose();
                  },
                  onError: (e) => toast.error('Could not write a new draft', errorMessage(e)),
                },
              )
            }
          >
            Write new draft
          </SubmitButton>
        </>
      }
    >
      <p className="muted">
        The current text stays in the version history. Choose a different topic if the label was wrong.
      </p>
      <Field label="Topic">
        {(id) => (
          <select id={id} className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Let the writer decide</option>
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
          <select id={id} className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">Keep {names.language(n.language)}</option>
            {config.data?.languages.map((l) => (
              <option key={l} value={l}>
                {names.language(l)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Guidance (optional)">
        {(id) => (
          <input
            id={id}
            className="input"
            maxLength={500}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

function DispatchDialog({ d, onClose }: { d: NarrativeDetailDto; onClose: () => void }) {
  const n = d.narrative;
  const names = useNames();
  const config = useNarrativeConfig();
  const m = useDispatchNarrative(n.id);
  const toast = useToast();
  const mock = config.data?.dispatcher.mode !== 'live';
  return (
    <Dialog
      title="Send this reply"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton
            className="btn btn--danger"
            pending={m.isPending}
            onClick={() =>
              m.mutate(undefined, {
                onSuccess: (r) => {
                  if (r.status === 'sent')
                    toast.success(
                      'Sent',
                      mock
                        ? 'Mock dispatcher: nothing was posted publicly.'
                        : `Posted to ${names.platform(r.platform)}.`,
                    );
                  else toast.error('It could not be sent', r.error ?? undefined);
                  onClose();
                },
                onError: (e) => toast.error('Could not send', errorMessage(e)),
              })
            }
          >
            <Icon name="dispatch" size={16} /> Send now
          </SubmitButton>
        </>
      }
    >
      {mock ? (
        <Callout tone="warn" icon="flask">
          The dispatcher is in mock mode. Sending is recorded, but nothing is posted anywhere.
        </Callout>
      ) : (
        <Callout tone="bad" icon="alert">
          This posts publicly to {names.platform(n.platform)}. It cannot be taken back from here.
        </Callout>
      )}
      <p className="quote">{n.text}</p>
    </Dialog>
  );
}
