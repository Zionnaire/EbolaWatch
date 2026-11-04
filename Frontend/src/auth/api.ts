import { z } from 'zod';
import {
  AcceptInviteRequestSchema,
  ChangePasswordRequestSchema,
  ClaimInfoDtoSchema,
  ClaimRequestSchema,
  InviteInfoDtoSchema,
  LoginRequestSchema,
  MeDtoSchema,
} from '@/contracts';
import { api, get, post } from '@/api/client';

export const authKeys = {
  me: ['auth', 'me'] as const,
};

export const fetchMe = (signal?: AbortSignal) => get('/api/auth/me', MeDtoSchema, undefined, signal);
export const login = (body: z.input<typeof LoginRequestSchema>) => post('/api/auth/login', MeDtoSchema, body);
export const logout = () => api<{ ok: boolean }>('POST', '/api/auth/logout', { body: {} });
export const changePassword = (body: z.input<typeof ChangePasswordRequestSchema>) =>
  post('/api/auth/change-password', MeDtoSchema, body);

export const claimInfo = (token: string) =>
  get(`/api/auth/claim/${encodeURIComponent(token)}`, ClaimInfoDtoSchema);
export const claim = (token: string, body: z.input<typeof ClaimRequestSchema>) =>
  post(`/api/auth/claim/${encodeURIComponent(token)}`, MeDtoSchema, body);
export const inviteInfo = (token: string) =>
  get(`/api/auth/invite/${encodeURIComponent(token)}`, InviteInfoDtoSchema);
export const acceptInvite = (token: string, body: z.input<typeof AcceptInviteRequestSchema>) =>
  post(`/api/auth/invite/${encodeURIComponent(token)}`, MeDtoSchema, body);
