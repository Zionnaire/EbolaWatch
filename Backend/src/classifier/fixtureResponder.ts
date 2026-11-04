/**
 * Deterministic fixture picking shared by InProcessMockClassifier and the mock model server.
 * (The server may import production code; production code must not import the server.)
 */
import { createHash } from 'node:crypto';
import { FIXTURES, loadFixture } from '../contracts/fixtures/index.js';
import type { ClassifyResponse, CompletedItem } from '../contracts/model/multilabelV1.js';
import type { ThreeClassResponse } from '../contracts/model/threeClassV0.js';
import { mockLanguage } from './languageGuess.js';

export const MOCK_MODEL_NAME = 'mock-ebola-clf';
export const MOCK_MODEL_VERSION = '0.0.0-mock';
export const MOCK_THREECLASS_NAME = 'mock-legacy-3class';

/** Deterministic hash of a string into [0, 2^32). */
export function hash32(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0);
}

type ThreeClassCompleted = Extract<ThreeClassResponse['results'][number], { status: 'completed' }>;

let multilabelPool: CompletedItem[] | null = null;
let threeClassPool: ThreeClassCompleted[] | null = null;

/** What the item says about itself, so the mock can report the right language instead of a random one. */
export interface PickContext {
  languageHint?: string | null;
  text?: string;
}

export function pickMultilabel(itemId: string, ctx: PickContext = {}): CompletedItem {
  multilabelPool ??= [FIXTURES.categories, FIXTURES.completed, FIXTURES.irrelevant]
    .flatMap((f) => loadFixture<ClassifyResponse>(f).results)
    .filter((r): r is CompletedItem => r.status === 'completed');
  const pick = { ...multilabelPool[hash32(itemId) % multilabelPool.length]!, item_id: itemId };
  const lang = mockLanguage(ctx.languageHint, ctx.text);
  return lang ? { ...pick, language: { ...pick.language, primary: lang } } : pick;
}

export function pickThreeClass(itemId: string, ctx: PickContext = {}): ThreeClassCompleted {
  threeClassPool ??= loadFixture<ThreeClassResponse>(FIXTURES.threeClass).results.filter(
    (r): r is ThreeClassCompleted => r.status === 'completed',
  );
  const pick = { ...threeClassPool[hash32(itemId) % threeClassPool.length]!, item_id: itemId };
  const lang = mockLanguage(ctx.languageHint, ctx.text);
  return lang ? { ...pick, language: lang } : pick;
}
