import { useState } from 'react';
import { useInvites, useInviteUser, useRevokeInvite, useUpdateUser, useUsers } from '@/api/queries';
import { useSession } from '@/auth/AuthProvider';
import { useToast } from '@/components/feedback/Toast';
import { OneTimeLinkDialog } from '@/components/OneTimeLinkDialog';
import {
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
import { INVITABLE_ROLES } from '@/contracts';
import type { InviteResponseSchema } from '@/contracts';
import { ROLE_LABEL } from '@/config/status';
import { Icon } from '@/icons';
import { formatDateTime, timeAgo } from '@/utils/format';
import type { z } from 'zod';

export default function Team() {
  const { me } = useSession();
  const users = useUsers();
  const invites = useInvites();
  const update = useUpdateUser();
  const revoke = useRevokeInvite();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<z.infer<typeof InviteResponseSchema>['link'] | null>(null);

  const open = invites.data?.filter((i) => !i.usedAt) ?? [];

  return (
    <div className="stack stack--lg">
      <PageHeader
        eyebrow="Oversee"
        title="Team"
        lead="People in your organization. New people join by a one-time invitation link."
        actions={
          <button className="btn" onClick={() => setInviting(true)}>
            <Icon name="plus" size={18} /> Invite someone
          </button>
        }
      />

      <Card flush>
        {users.isPending ? (
          <div style={{ padding: 20 }}>
            <SkeletonRows rows={4} />
          </div>
        ) : users.isError && !users.data ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Last signed in</th>
                  <th scope="col">Access</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => {
                  const self = u.id === me?.user.id;
                  const editable = !self && u.role !== 'org_admin';
                  return (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.name}</strong> {self && <Chip tone="plain">You</Chip>}
                        <br />
                        <span className="muted small">{u.email}</span>
                      </td>
                      <td>
                        {editable ? (
                          <select
                            className="select"
                            aria-label={`Role for ${u.name}`}
                            value={u.role}
                            disabled={update.isPending}
                            onChange={(e) =>
                              update.mutate(
                                { id: u.id, role: e.target.value },
                                {
                                  onSuccess: () =>
                                    toast.success(
                                      `${u.name} is now ${ROLE_LABEL[e.target.value]?.toLowerCase()}`,
                                    ),
                                  onError: (er) => toast.error('Could not change the role', errorMessage(er)),
                                },
                              )
                            }
                            style={{ minWidth: 170 }}
                          >
                            {INVITABLE_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          (ROLE_LABEL[u.role] ?? u.role)
                        )}
                      </td>
                      <td className="muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}</td>
                      <td>
                        {editable ? (
                          <button
                            className={`btn btn--sm ${u.isActive ? 'btn--ghost' : ''}`}
                            disabled={update.isPending}
                            onClick={() =>
                              update.mutate(
                                { id: u.id, isActive: !u.isActive },
                                {
                                  onSuccess: () =>
                                    toast.success(
                                      u.isActive
                                        ? `${u.name} can no longer sign in`
                                        : `${u.name} can sign in again`,
                                    ),
                                  onError: (er) => toast.error('Could not change access', errorMessage(er)),
                                },
                              )
                            }
                          >
                            {u.isActive ? 'Turn off access' : 'Turn on access'}
                          </button>
                        ) : (
                          <Chip tone={u.isActive ? 'ok' : 'bad'}>{u.isActive ? 'Active' : 'Off'}</Chip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Waiting to join" sub="Invitations that have not been used yet">
        {invites.isPending ? (
          <SkeletonRows rows={2} />
        ) : open.length === 0 ? (
          <EmptyState scene="inbox" title="No open invitations" />
        ) : (
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {open.map((i) => (
              <li key={i.id} className="row row--between">
                <div>
                  <strong>{i.email}</strong> <span className="muted">· {ROLE_LABEL[i.role]}</span>
                  <p className="faint small">Expires {formatDateTime(i.expiresAt)}</p>
                </div>
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(i.id, {
                      onSuccess: () => toast.info('Invitation withdrawn'),
                      onError: (e) => toast.error('Could not withdraw it', errorMessage(e)),
                    })
                  }
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onCreated={(l) => {
            setInviting(false);
            setLink(l);
          }}
        />
      )}
      {link && (
        <OneTimeLinkDialog
          title="Invitation ready"
          intro="Send this link to the person. They choose their own password."
          link={link}
          onClose={() => setLink(null)}
        />
      )}
    </div>
  );
}

function InviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (l: z.infer<typeof InviteResponseSchema>['link']) => void;
}) {
  const invite = useInviteUser();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('analyst');
  return (
    <Dialog
      title="Invite someone"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton
            pending={invite.isPending}
            disabled={!email.includes('@')}
            onClick={() =>
              invite.mutate(
                { email, role },
                {
                  onSuccess: (r) => onCreated(r.link),
                  onError: (e) => toast.error('Could not create the invitation', errorMessage(e)),
                },
              )
            }
          >
            Create invitation
          </SubmitButton>
        </>
      }
    >
      <Field label="Their email">
        {(id) => (
          <input
            id={id}
            className="input"
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Role"
        hint="Analysts review and draft. Senior analysts and supervisors can also approve and send."
      >
        {(id, by) => (
          <select
            id={id}
            aria-describedby={by}
            className="select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {INVITABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        )}
      </Field>
    </Dialog>
  );
}
