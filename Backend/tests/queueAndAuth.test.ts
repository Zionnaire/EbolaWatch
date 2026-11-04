import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { ingestKey } from '../src/middlewares/ingestKey.js';
import { MockConnector } from '../src/pipeline/connectors/mockConnector.js';
import { SYNTHETIC_CORPUS } from '../src/pipeline/connectors/syntheticCorpus.js';
import { WorkQueue } from '../src/pipeline/queue.js';
import { RawPostSchema } from '../src/contracts/api/index.js';
import { scrubPii } from '../src/utils/pii.js';

describe('WorkQueue', () => {
  it('processes in batches of at most batchSize, FIFO, and de-duplicates', async () => {
    const batches: string[][] = [];
    const q = new WorkQueue({ cap: 100, batchSize: 3, handler: async (ids) => void batches.push(ids) });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(ids.map((id) => q.enqueue(id))).toEqual(Array(5).fill('queued'));
    expect(q.enqueue('a')).toBe('duplicate');
    await q.idle();
    expect(batches).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
    expect(q.size()).toBe(0);
  });

  it('reports full at the cap and recovers capacity once drained', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const q = new WorkQueue({ cap: 2, batchSize: 10, handler: () => gate });
    expect(q.enqueue('a')).toBe('queued');
    expect(q.enqueue('b')).toBe('queued');
    expect(q.enqueue('c')).toBe('full');
    expect(q.capacityLeft()).toBe(0);
    release();
    await q.idle();
    expect(q.capacityLeft()).toBe(2);
    expect(q.enqueue('c')).toBe('queued');
    await q.idle();
  });

  it('a throwing handler does not kill the worker; later work still runs', async () => {
    const seen: string[] = [];
    let first = true;
    const q = new WorkQueue({
      cap: 10,
      batchSize: 1,
      handler: async (ids) => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        seen.push(...ids);
      },
    });
    q.enqueue('a');
    q.enqueue('b');
    await q.idle();
    expect(seen).toEqual(['b']);
  });

  it('calls onDrained after draining and picks up anything it enqueues', async () => {
    const handled: string[] = [];
    let extra = true;
    const q: WorkQueue = new WorkQueue({
      cap: 10,
      batchSize: 5,
      handler: async (ids) => void handled.push(...ids),
      onDrained: () => {
        if (extra) {
          extra = false;
          q.enqueue('late');
        }
      },
    });
    q.enqueue('first');
    await q.idle();
    expect(handled).toEqual(['first', 'late']);
  });

  it('idle() resolves immediately when nothing is queued; stop() refuses new work', async () => {
    const q = new WorkQueue({ cap: 5, batchSize: 5, handler: async () => undefined });
    await q.idle();
    q.stop();
    expect(q.enqueue('x')).toBe('full');
  });
});

describe('ingestKey', () => {
  const KEY = 'secret-ingest-key-123456';
  const app = (() => {
    const a = express();
    a.post('/ingest', ingestKey(KEY), (_req, res) => res.json({ ok: true }));
    a.use(errorHandler);
    return a;
  })();

  it('accepts X-Api-Key and Bearer tokens', async () => {
    expect((await request(app).post('/ingest').set('X-Api-Key', KEY)).status).toBe(200);
    expect((await request(app).post('/ingest').set('Authorization', `Bearer ${KEY}`)).status).toBe(200);
  });

  it('rejects missing, wrong and different-length keys with 401', async () => {
    for (const set of [undefined, 'wrong', KEY + 'x', '']) {
      const req = request(app).post('/ingest');
      if (set !== undefined) req.set('X-Api-Key', set);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_api_key');
    }
  });
});

describe('MockConnector', () => {
  const make = (batchSize = 4, runId = 'r1') => {
    const ingest = vi.fn().mockResolvedValue({ accepted: batchSize, duplicates: 0, rejected: [], ids: [] });
    const connector = new MockConnector(
      { ingest },
      { intervalMs: 1000, batchSize, runId, now: () => new Date('2026-10-27T12:00:00Z') },
      true,
    );
    return { ingest, connector };
  };

  it('emits valid RawPosts with unique sourceIds that cycle the corpus and platforms', async () => {
    const { connector } = make(30);
    const batch = connector.nextBatch();
    expect(batch).toHaveLength(30);
    for (const p of batch) expect(RawPostSchema.safeParse(p).success).toBe(true);
    expect(new Set(batch.map((p) => p.sourceId)).size).toBe(30);
    expect(new Set(batch.map((p) => p.platform)).size).toBeGreaterThan(1);
    expect(batch[0]!.text).toBe(SYNTHETIC_CORPUS[0]!.text);
    expect(batch[SYNTHETIC_CORPUS.length]!.text).toBe(SYNTHETIC_CORPUS[0]!.text);
  });

  it('sourceIds are namespaced by run so a restart never collides', () => {
    const a = make(2, 'run-a').connector.nextBatch();
    const b = make(2, 'run-b').connector.nextBatch();
    expect(a[0]!.sourceId).not.toBe(b[0]!.sourceId);
  });

  it('tick sends one batch through the ingest sink; status follows the enabled flag', async () => {
    const { ingest, connector } = make(3);
    await connector.tick();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0]).toHaveLength(3);
    expect(connector.initialStatus).toBe('live');
    expect(new MockConnector({ ingest }, { intervalMs: 1, batchSize: 1 }, false).initialStatus).toBe(
      'paused',
    );
  });

  it('the corpus is synthetic and exercises the scrubber (handles, urls, phones) without leaking them', () => {
    const joined = SYNTHETIC_CORPUS.map((c) => scrubPii(c.text)).join('\n');
    expect(joined).not.toMatch(/@\w/);
    expect(joined).not.toMatch(/https?:\/\//);
    expect(joined).not.toMatch(/0803 000 0000|0805 000 0000/);
    expect(SYNTHETIC_CORPUS.some((c) => /\[phone\]/.test(scrubPii(c.text)))).toBe(true);
    expect(new Set(SYNTHETIC_CORPUS.map((c) => c.language))).toEqual(
      new Set(['en', 'pcm', 'ha', 'yo', 'ig', 'fr', 'und']),
    );
  });
});
