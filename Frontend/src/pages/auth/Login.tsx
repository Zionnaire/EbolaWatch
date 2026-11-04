import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { login } from '@/auth/api';
import { useSession } from '@/auth/AuthProvider';
import { Callout, Field, SubmitButton } from '@/components/ui';
import { useToast } from '@/components/feedback/Toast';
import { useMutation } from '@tanstack/react-query';
import { AuthLayout } from './AuthLayout';

export default function Login() {
  const { state, setSession } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => login({ email, password }),
    onSuccess: (me) => {
      setSession(me);
      toast.success(`Welcome, ${me.user.name.split(' ')[0]}`);
      navigate(from, { replace: true });
    },
  });

  if (state === 'signedIn') return <Navigate to={from} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate();
  };
  const err = signIn.error;
  const message =
    err instanceof ApiError
      ? err.status === 401
        ? 'That email and password do not match.'
        : err.status === 403
          ? 'This account or its organization is not active. Contact your administrator.'
          : err.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : err.message
      : err
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <AuthLayout>
      <form onSubmit={submit} className="stack" noValidate>
        <div>
          <h1>Sign in</h1>
          <p className="muted">Use the account your organization gave you.</p>
        </div>
        {message && (
          <Callout tone="bad" icon="alert">
            {message}
          </Callout>
        )}
        <Field label="Email">
          {(id) => (
            <input
              id={id}
              className="input"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(id) => (
            <input
              id={id}
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <SubmitButton pending={signIn.isPending} disabled={!email || !password} type="submit">
          Sign in
        </SubmitButton>
        <p className="faint small">
          Accounts are created by invitation. If you do not have one, ask the administrator of your
          organization.
        </p>
      </form>
    </AuthLayout>
  );
}
