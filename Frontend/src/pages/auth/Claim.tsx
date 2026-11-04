import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { acceptInvite, claim, claimInfo, inviteInfo } from '@/auth/api';
import { useSession } from '@/auth/AuthProvider';
import { useToast } from '@/components/feedback/Toast';
import { Callout, Field, SkeletonRows, SubmitButton } from '@/components/ui';
import { ORG_TYPE_LABEL, ROLE_LABEL } from '@/config/status';
import { AuthLayout } from './AuthLayout';

/** Shared form for the two one-time-link pages: set up the first admin (claim) or join as invited (invite). */
export function OneTimeLinkPage({ mode }: { mode: 'claim' | 'invite' }) {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { setSession } = useSession();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const info = useQuery({
    queryKey: ['link', mode, token],
    queryFn: async () => {
      if (mode === 'claim') {
        const c = await claimInfo(token);
        return {
          orgName: c.organization.name,
          orgType: c.organization.type as string | null,
          email: null as string | null,
          role: null as string | null,
        };
      }
      const i = await inviteInfo(token);
      return { orgName: i.organization.name, orgType: null, email: i.email, role: i.role as string };
    },
    retry: false,
  });

  const submit = useMutation({
    mutationFn: () =>
      mode === 'claim' ? claim(token, { name, email, password }) : acceptInvite(token, { name, password }),
    onSuccess: (me) => {
      setSession(me);
      toast.success(
        'Your account is ready',
        `You are signed in to ${me.organization?.name ?? 'EbolaWatch'}.`,
      );
      navigate('/', { replace: true });
    },
  });

  const mismatch = confirm.length > 0 && confirm !== password;
  const fields = submit.error instanceof ApiError ? submit.error.fieldErrors() : {};

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) submit.mutate();
  };

  if (info.isPending)
    return (
      <AuthLayout>
        <SkeletonRows rows={4} h={36} />
      </AuthLayout>
    );

  if (info.isError)
    return (
      <AuthLayout>
        <div className="stack">
          <h1>This link cannot be used</h1>
          <Callout tone="warn" icon="warning">
            It may have expired, or it was already used. Links work once. Ask for a new one.
          </Callout>
          <Link to="/login" className="btn btn--ghost">
            Go to sign in
          </Link>
        </div>
      </AuthLayout>
    );

  const d = info.data;
  const heading = mode === 'claim' ? `Set up ${d.orgName}` : `Join ${d.orgName}`;
  const sub =
    mode === 'claim'
      ? `You will be the administrator of this ${(ORG_TYPE_LABEL[d.orgType ?? ''] ?? '').toLowerCase()} account.`
      : `You are invited as ${(ROLE_LABEL[d.role ?? ''] ?? 'a team member').toLowerCase()}.`;

  return (
    <AuthLayout>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <div>
          <h1>{heading}</h1>
          <p className="muted">{sub}</p>
        </div>
        {submit.error && !Object.keys(fields).length && (
          <Callout tone="bad" icon="alert">
            {submit.error instanceof ApiError ? submit.error.message : 'Something went wrong. Try again.'}
          </Callout>
        )}
        <Field label="Your name" error={fields.name}>
          {(id) => (
            <input
              id={id}
              className="input"
              autoComplete="name"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {mode === 'claim' ? (
          <Field label="Email" error={fields.email}>
            {(id) => (
              <input
                id={id}
                className="input"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
        ) : (
          <Field label="Email">
            {(id) => <input id={id} className="input" value={d.email ?? ''} readOnly />}
          </Field>
        )}
        <Field
          label="Password"
          hint="At least 10 characters. A short sentence works well."
          error={fields.password}
        >
          {(id, by) => (
            <input
              id={id}
              aria-describedby={by}
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Repeat password" error={mismatch ? 'The passwords do not match.' : undefined}>
          {(id) => (
            <input
              id={id}
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
          )}
        </Field>
        <SubmitButton
          pending={submit.isPending}
          type="submit"
          disabled={!name || !password || mismatch || (mode === 'claim' && !email)}
        >
          Create account
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}

export default function Claim() {
  return <OneTimeLinkPage mode="claim" />;
}
