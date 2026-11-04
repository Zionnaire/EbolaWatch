import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ApiError, registerUnauthorizedHandler } from '@/api/client';
import type { MeDto } from '@/contracts';
import { authKeys, fetchMe, logout as logoutRequest } from './api';

/** What the server's permission table can answer for this user (see Backend src/auth/permissions.ts). */
export type Permission = string;

interface Session {
  /** `loading` only on the very first check; after that the last known answer stays while it refreshes. */
  state: 'loading' | 'signedIn' | 'signedOut';
  me: MeDto | null;
  can: (permission: Permission) => boolean;
  /** Puts a fresh session (from login / claim / accept-invite) into the cache. */
  setSession: (me: MeDto) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

/**
 * The one piece of app-wide state that is not a plain query: who is signed in. It is still a query underneath
 * (`['auth','me']`); the context only gives it a convenient shape and the `can()` helper.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: authKeys.me,
    queryFn: async ({ signal }) => {
      try {
        return await fetchMe(signal);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const clear = useCallback(() => {
    qc.setQueryData(authKeys.me, null);
    // nothing from the previous person may linger in the cache
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
  }, [qc]);

  useEffect(() => registerUnauthorizedHandler(clear), [clear]);

  const me = query.data ?? null;
  const value = useMemo<Session>(
    () => ({
      state: query.isPending ? 'loading' : me ? 'signedIn' : 'signedOut',
      me,
      can: (p) => !!me?.permissions.includes(p),
      setSession: (next) => {
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
        qc.setQueryData(authKeys.me, next);
      },
      signOut: async () => {
        try {
          await logoutRequest();
        } finally {
          clear();
        }
      },
    }),
    [me, query.isPending, qc, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside <AuthProvider>');
  return v;
}

export const useCan = (permission: Permission) => useSession().can(permission);

/** Renders its children only when the signed-in user holds the permission. The server enforces it regardless. */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return <>{useCan(permission) ? children : fallback}</>;
}
