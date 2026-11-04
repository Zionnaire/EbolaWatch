import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, get, post, registerUnauthorizedHandler } from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  registerUnauthorizedHandler(() => undefined);
});

describe('api client', () => {
  it('returns validated data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { n: 3 })));
    await expect(get('/api/x', z.object({ n: z.number() }))).resolves.toEqual({ n: 3 });
  });

  it('a response that breaks the contract is a contract_mismatch, not a crash further down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { n: 'three' })));
    await expect(get('/api/x', z.object({ n: z.number() }))).rejects.toMatchObject({
      code: 'contract_mismatch',
    });
  });

  it('turns the server error shape into an ApiError with field errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(400, {
          error: {
            code: 'validation_error',
            message: 'Invalid request',
            issues: [{ path: ['password'], message: 'Too short' }],
          },
        }),
      ),
    );
    const err = await post('/api/x', z.unknown(), {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).fieldErrors()).toEqual({ password: 'Too short' });
  });

  it('a network failure becomes a readable ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(get('/api/x', z.unknown())).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('on 401 it refreshes once, then retries the request with the new session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthenticated', message: 'no' } }))
      .mockResolvedValueOnce(json(200, { ok: true })) // /api/auth/refresh
      .mockResolvedValueOnce(json(200, { n: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(get('/api/x', z.object({ n: z.number() }))).resolves.toEqual({ n: 1 });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/x', '/api/auth/refresh', '/api/x']);
  });

  it('parallel 401s share one refresh', async () => {
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        if (input.startsWith('/api/auth/refresh')) {
          refreshes++;
          return Promise.resolve(json(200, { ok: true }));
        }
        // first call to each path is rejected, the retry succeeds
        const key = `seen:${input}`;
        const g = globalThis as unknown as Record<string, boolean>;
        if (!g[key]) {
          g[key] = true;
          return Promise.resolve(json(401, { error: { code: 'unauthenticated', message: 'no' } }));
        }
        delete g[key];
        void init;
        return Promise.resolve(json(200, { n: 1 }));
      }),
    );
    await Promise.all([
      get('/api/a', z.object({ n: z.number() })),
      get('/api/b', z.object({ n: z.number() })),
    ]);
    expect(refreshes).toBe(1);
  });

  it('when the refresh fails the session is treated as over', async () => {
    const onUnauthorized = vi.fn();
    registerUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(401, { error: { code: 'unauthenticated', message: 'no' } }))
        .mockResolvedValueOnce(json(401, { error: { code: 'unauthenticated', message: 'no' } }))
        .mockResolvedValueOnce(json(401, { error: { code: 'unauthenticated', message: 'no' } })),
    );
    await expect(get('/api/x', z.unknown())).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('never tries to refresh around the sign-in call itself', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(401, { error: { code: 'invalid_credentials', message: 'bad' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(post('/api/auth/login', z.unknown(), {})).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
