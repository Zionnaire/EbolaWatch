/**
 * Every server read and write the app does. Server state lives in TanStack Query and nowhere else: there is no
 * second copy in context or stores. Sockets patch or invalidate these same keys (see sockets/useLiveSync).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BreakdownDtoSchema,
  ClustersDtoSchema,
  ConnectorDtoSchema,
  CreateOrganizationResponseSchema,
  DispatchDtoSchema,
  DispatchListDtoSchema,
  GeoDtoSchema,
  InviteDtoSchema,
  InviteResponseSchema,
  KnowledgeDtoSchema,
  ModelHealthDtoSchema,
  NarrativeConfigDtoSchema,
  NarrativeDetailDtoSchema,
  NarrativeDtoSchema,
  NarrativeListDtoSchema,
  OneTimeLinkSchema,
  OrganizationDtoSchema,
  OrgOverviewDtoSchema,
  PostDetailDtoSchema,
  PostListDtoSchema,
  RecomputeResultSchema,
  RulesConfigSchema,
  SummaryDtoSchema,
  SystemStatusSchema,
  TaxonomyDtoSchema,
  TimeseriesDtoSchema,
  UserDtoSchema,
  type GenerateNarrativeRequest,
  type NarrativeStatus,
  type OperatingMode,
  type OrgSettingsPatch,
  type OrgStatus,
  type PostListQuery,
  type RegenerateNarrativeRequest,
  type ReviewRequest,
} from '@/contracts';
import { del, get, patch, post } from './client';

export const keys = {
  status: ['system', 'status'] as const,
  taxonomy: (version?: string | null) => ['taxonomy', version ?? 'current'] as const,
  rules: ['rules'] as const,
  connectors: ['connectors'] as const,
  posts: (q?: unknown) => (q === undefined ? (['posts'] as const) : (['posts', 'list', q] as const)),
  post: (id: string) => ['posts', 'detail', id] as const,
  narratives: (q?: unknown) =>
    q === undefined ? (['narratives'] as const) : (['narratives', 'list', q] as const),
  narrative: (id: string) => ['narratives', 'detail', id] as const,
  narrativeConfig: ['narratives', 'config'] as const,
  dispatches: (q?: unknown) =>
    q === undefined ? (['dispatches'] as const) : (['dispatches', 'list', q] as const),
  analytics: (name: string, q?: unknown) => ['analytics', name, q ?? null] as const,
  orgs: ['orgs'] as const,
  orgOverview: ['orgs', 'overview'] as const,
  myOrg: ['orgs', 'me'] as const,
  users: ['users'] as const,
  invites: ['users', 'invites'] as const,
};

// ---- system ----

export const useSystemStatus = () =>
  useQuery({
    queryKey: keys.status,
    queryFn: ({ signal }) => get('/api/system/status', SystemStatusSchema, undefined, signal),
    // the socket keeps this fresh; polling is only the safety net
    refetchInterval: 60_000,
  });

export const useTaxonomyQuery = (version?: string | null) =>
  useQuery({
    queryKey: keys.taxonomy(version),
    queryFn: ({ signal }) =>
      get('/api/taxonomy', TaxonomyDtoSchema, version ? { version } : undefined, signal),
    staleTime: 10 * 60_000,
    retry: false,
  });

export const useRules = () =>
  useQuery({
    queryKey: keys.rules,
    queryFn: ({ signal }) => get('/api/rules', z.array(RulesConfigSchema), undefined, signal),
    staleTime: 5 * 60_000,
  });

/** The fact base behind the writer. A 404 just means none is loaded, so no retry. */
export const useKnowledge = () =>
  useQuery({
    queryKey: ['knowledge'] as const,
    queryFn: ({ signal }) => get('/api/knowledge', KnowledgeDtoSchema, undefined, signal),
    staleTime: 5 * 60_000,
    retry: false,
  });

export const useConnectors = () =>
  useQuery({
    queryKey: keys.connectors,
    queryFn: ({ signal }) => get('/api/connectors', z.array(ConnectorDtoSchema), undefined, signal),
  });

export function useSetMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: OperatingMode) =>
      post('/api/admin/mode', z.object({ mode: z.string(), previous: z.string().nullable().optional() }), {
        mode,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.status }),
  });
}

export function useRecompute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post('/api/admin/recompute-decisions', RecomputeResultSchema),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.posts() });
      void qc.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}

// ---- posts ----

export type PostFilters = Partial<Omit<PostListQuery, 'page' | 'pageSize'>> & {
  page?: number;
  pageSize?: number;
};

export const usePosts = (filters: PostFilters, opts: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: keys.posts(filters),
    queryFn: ({ signal }) =>
      get('/api/posts', PostListDtoSchema, filters as Record<string, string | number>, signal),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });

export const usePost = (id: string | undefined) =>
  useQuery({
    queryKey: keys.post(id ?? ''),
    queryFn: ({ signal }) => get(`/api/posts/${id}`, PostDetailDtoSchema, undefined, signal),
    enabled: !!id,
  });

export function useReviewPost(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReviewRequest) => post(`/api/posts/${id}/review`, z.unknown(), body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.post(id) });
      void qc.invalidateQueries({ queryKey: keys.posts() });
      void qc.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}

// ---- narratives and dispatch ----

export const useNarrativeConfig = () =>
  useQuery({
    queryKey: keys.narrativeConfig,
    queryFn: ({ signal }) => get('/api/narratives/config', NarrativeConfigDtoSchema, undefined, signal),
    staleTime: 10 * 60_000,
  });

export const useNarratives = (
  q: { postId?: string; status?: NarrativeStatus; page?: number; pageSize?: number },
  enabled = true,
) =>
  useQuery({
    queryKey: keys.narratives(q),
    queryFn: ({ signal }) =>
      get('/api/narratives', NarrativeListDtoSchema, q as Record<string, string | number>, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useNarrative = (id: string | undefined) =>
  useQuery({
    queryKey: keys.narrative(id ?? ''),
    queryFn: ({ signal }) => get(`/api/narratives/${id}`, NarrativeDetailDtoSchema, undefined, signal),
    enabled: !!id,
  });

export const useDispatches = (q: { page?: number; pageSize?: number } = {}) =>
  useQuery({
    queryKey: keys.dispatches(q),
    queryFn: ({ signal }) =>
      get('/api/dispatches', DispatchListDtoSchema, q as Record<string, number>, signal),
    placeholderData: keepPreviousData,
  });

function useNarrativeInvalidation() {
  const qc = useQueryClient();
  return (id?: string) => {
    void qc.invalidateQueries({ queryKey: keys.narratives() });
    void qc.invalidateQueries({ queryKey: keys.dispatches() });
    if (id) void qc.invalidateQueries({ queryKey: keys.narrative(id) });
    void qc.invalidateQueries({ queryKey: ['analytics', 'summary'] });
  };
}

export function useGenerateNarrative() {
  const done = useNarrativeInvalidation();
  return useMutation({
    mutationFn: (body: GenerateNarrativeRequest) =>
      post('/api/narratives/generate', NarrativeDetailDtoSchema, body),
    onSuccess: (d) => done(d.narrative.id),
  });
}

export function useEditNarrative(id: string) {
  const done = useNarrativeInvalidation();
  return useMutation({
    mutationFn: (text: string) => patch(`/api/narratives/${id}`, NarrativeDetailDtoSchema, { text }),
    onSuccess: () => done(id),
  });
}

export function useRegenerateNarrative(id: string) {
  const done = useNarrativeInvalidation();
  return useMutation({
    mutationFn: (body: RegenerateNarrativeRequest) =>
      post(`/api/narratives/${id}/regenerate`, NarrativeDetailDtoSchema, body),
    onSuccess: () => done(id),
  });
}

export function useNarrativeDecision(id: string, action: 'approve' | 'reject') {
  const done = useNarrativeInvalidation();
  return useMutation({
    mutationFn: (note?: string) =>
      post(`/api/narratives/${id}/${action}`, NarrativeDetailDtoSchema, note ? { note } : {}),
    onSuccess: () => done(id),
  });
}

export function useDispatchNarrative(id: string) {
  const done = useNarrativeInvalidation();
  return useMutation({
    mutationFn: () => post(`/api/narratives/${id}/dispatch`, DispatchDtoSchema),
    onSuccess: () => done(id),
  });
}

// ---- analytics ----

const analyticsQuery = <T>(
  name: string,
  schema: z.ZodType<T>,
  q?: Record<string, number>,
  refetchMs?: number,
) => ({
  queryKey: keys.analytics(name, q),
  queryFn: ({ signal }: { signal: AbortSignal }) => get(`/api/analytics/${name}`, schema, q, signal),
  refetchInterval: refetchMs,
  placeholderData: keepPreviousData,
});

export const useSummary = () => useQuery(analyticsQuery('summary', SummaryDtoSchema, undefined, 60_000));
export const useTimeseries = (days = 7) =>
  useQuery(analyticsQuery('timeseries', TimeseriesDtoSchema, { days }));
export const useBreakdown = (days = 7) => useQuery(analyticsQuery('breakdown', BreakdownDtoSchema, { days }));
export const useClusters = (days = 7) => useQuery(analyticsQuery('clusters', ClustersDtoSchema, { days }));
export const useGeo = () => useQuery(analyticsQuery('geo', GeoDtoSchema));
export const useModelHealth = (days = 30) =>
  useQuery(analyticsQuery('model-health', ModelHealthDtoSchema, { days }));

// ---- organizations and people ----

export const useOrganizations = (enabled = true) =>
  useQuery({
    queryKey: keys.orgs,
    queryFn: ({ signal }) => get('/api/organizations', z.array(OrganizationDtoSchema), undefined, signal),
    enabled,
  });

export const useOrgOverview = (enabled = true) =>
  useQuery({
    queryKey: keys.orgOverview,
    queryFn: ({ signal }) => get('/api/organizations/overview', OrgOverviewDtoSchema, undefined, signal),
    enabled,
  });

export const useMyOrganization = (enabled = true) =>
  useQuery({
    queryKey: keys.myOrg,
    queryFn: ({ signal }) => get('/api/organizations/me', OrganizationDtoSchema, undefined, signal),
    enabled,
  });

export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; type: string; region?: string; scopeStates?: string[] }) =>
      post('/api/organizations', CreateOrganizationResponseSchema, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.orgs }),
  });
}

export function useSetOrgStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrgStatus }) =>
      patch(`/api/organizations/${id}/status`, OrganizationDtoSchema, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.orgs }),
  });
}

export const useRegenerateClaimLink = () =>
  useMutation({
    mutationFn: (id: string) =>
      post(`/api/organizations/${id}/claim-link`, z.object({ claimLink: OneTimeLinkSchema })),
  });

export function useUpdateMySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OrgSettingsPatch) =>
      patch('/api/organizations/me/settings', OrganizationDtoSchema, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.myOrg });
      void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

export const useUsers = (enabled = true) =>
  useQuery({
    queryKey: keys.users,
    queryFn: ({ signal }) => get('/api/users', z.array(UserDtoSchema), undefined, signal),
    enabled,
  });

export const useInvites = (enabled = true) =>
  useQuery({
    queryKey: keys.invites,
    queryFn: ({ signal }) => get('/api/users-invites', z.array(InviteDtoSchema), undefined, signal),
    enabled,
  });

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: string; isActive?: boolean }) =>
      patch(`/api/users/${id}`, UserDtoSchema, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.users }),
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: string }) =>
      post('/api/users-invites', InviteResponseSchema, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites }),
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/api/users-invites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites }),
  });
}

// keep the schema exported for callers that need the type of a freshly created narrative
export { NarrativeDtoSchema };
