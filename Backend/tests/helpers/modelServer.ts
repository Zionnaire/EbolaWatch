import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import {
  createMockModelApp,
  type MockControlState,
  type MockModelOptions,
} from '../../src/mock-model/app.js';

export interface RunningModel {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  /** Virtual time. The mock model reads it for warm-ups; use `advance` (or a classifier `sleep` that calls it). */
  clock: { now: number };
  advance(ms: number): void;
  /** Direct access to the mock's control state. */
  state: MockControlState;
  /** POST /__control, as an operator would. */
  control(patch: Record<string, unknown>): Promise<MockControlState>;
  requests: Array<{ method: string; path: string }>;
  count(path: string): number;
  close(): Promise<void>;
}

/**
 * Starts the real mock-model server (not a stub) on an ephemeral port. By default it runs on a virtual clock so
 * warm-ups can be exercised instantly; pass `realClock: true` when the caller uses real time too (e2e).
 */
export async function startModelServer(
  opts: MockModelOptions & { realClock?: boolean } = {},
): Promise<RunningModel> {
  const clock = { now: Date.now() };
  const { realClock, ...rest } = opts;
  const { app: inner, control: state } = createMockModelApp({
    ...rest,
    now: realClock ? Date.now : () => clock.now,
  });

  const requests: RunningModel['requests'] = [];
  const outer = express();
  outer.use((req, _res, next) => {
    requests.push({ method: req.method, path: req.path });
    next();
  });
  outer.use(inner);

  const server: Server = await new Promise((resolve) => {
    const s = outer.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    clock,
    advance: (ms) => {
      clock.now += ms;
    },
    state,
    control: async (patch) => {
      const res = await fetch(`${url}/__control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      return (await res.json()) as MockControlState;
    },
    requests,
    count: (path) => requests.filter((r) => r.path === path).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
