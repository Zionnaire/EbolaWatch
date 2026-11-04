import { Types } from 'mongoose';
import { ClassificationModel } from '../../src/models/Classification.js';
import { DecisionModel } from '../../src/models/Decision.js';
import { PostModel } from '../../src/models/Post.js';
import { textHash } from '../../src/utils/hashing.js';

export interface SeedSpec {
  sourceId?: string;
  platform?: string;
  text?: string;
  state?: string | null;
  lga?: string | null;
  isMock?: boolean;
  queue?: 'review' | 'information_gap' | 'none';
  finalSeverity?: number | null;
  priorityScore?: number;
  urgent?: boolean;
  categories?: string[];
  language?: string;
  stance?: string | null;
  /** This organization's review state (see `reviewedBy`); the global field it replaced is gone. */
  reviewStatus?: string;
  /** Which organization's review state `reviewStatus` describes. Defaults to the one set by `setSeedOrg`. */
  reviewedBy?: unknown;
  visibility?: 'global' | 'org';
  /** Owner of an `org`-visibility post. */
  organizationId?: Types.ObjectId | string | null;
  pipelineStatus?: string;
  ingestedAt?: Date;
  postedAt?: Date;
  classified?: boolean;
  taxonomyVersion?: string | null;
  contract?: 'multilabel-v1' | 'threeclass-v0';
  /** Score of the first category (default 0.9). */
  score?: number;
  latencyMs?: number;
  modelVersion?: string;
  /** When the classification (and decision) were created (default now). */
  createdAt?: Date;
}

let counter = 0;
let defaultReviewOrg: string | null = null;

/** The organization whose review state seeded posts carry when a spec sets `reviewStatus`. */
export function setSeedOrg(id: unknown): void {
  defaultReviewOrg = id === null || id === undefined ? null : String(id);
}

/** Inserts a fully formed Post (+ Classification + Decision) with exactly the triage values requested. */
export async function seedPost(spec: SeedSpec = {}) {
  const n = counter++;
  const classified = spec.classified ?? true;
  const text = spec.text ?? `synthetic post ${n}`;
  const isMock = spec.isMock ?? true;
  const post = await PostModel.create({
    platform: spec.platform ?? 'bluesky',
    sourceId: spec.sourceId ?? `seed-${n}-${new Types.ObjectId().toHexString()}`,
    authorHash: 'a'.repeat(64),
    text,
    state: spec.state ?? null,
    lga: spec.lga ?? null,
    postedAt: spec.postedAt ?? new Date(),
    ingestedAt: spec.ingestedAt ?? new Date(),
    pipelineStatus: spec.pipelineStatus ?? (classified ? 'classified' : 'pending'),
    visibility: spec.visibility ?? 'global',
    organizationId: spec.organizationId ? new Types.ObjectId(String(spec.organizationId)) : null,
    orgState:
      spec.reviewStatus && spec.reviewStatus !== 'unreviewed' && (spec.reviewedBy ?? defaultReviewOrg)
        ? { [String(spec.reviewedBy ?? defaultReviewOrg)]: { reviewStatus: spec.reviewStatus } }
        : {},
    isMock,
  });
  if (!classified) return { post, classification: null, decision: null };

  const contract = spec.contract ?? 'multilabel-v1';
  const categories = spec.categories ?? ['fake_cure_prevention'];
  const normalized =
    contract === 'multilabel-v1'
      ? {
          contract,
          modelName: 'mock-ebola-clf',
          modelVersion: spec.modelVersion ?? '0.0.0-mock',
          taxonomyVersion: spec.taxonomyVersion === undefined ? 'ebola-tax-1.0' : spec.taxonomyVersion,
          isRelevant: true,
          relevanceConfidence: 0.95,
          language: spec.language ?? 'en',
          stance: spec.stance === undefined ? 'endorses' : spec.stance,
          categories: categories.map((label, i) => ({
            label,
            score: i === 0 ? (spec.score ?? 0.9) : 0.9 - i * 0.1,
          })),
          severity: {
            level: spec.finalSeverity ?? 2,
            confidence: 0.7,
            distribution: [0.05, 0.1, 0.6, 0.15, 0.1],
          },
          threeClass: null,
          truncated: false,
          latencyMs: spec.latencyMs ?? 100,
        }
      : {
          contract,
          modelName: 'mock-legacy-3class',
          modelVersion: spec.modelVersion ?? '0.0.0-mock',
          taxonomyVersion: null,
          isRelevant: true,
          relevanceConfidence: 0.9,
          language: spec.language ?? 'en',
          stance: null,
          categories: [],
          severity: null,
          threeClass: {
            label: 'misinformation',
            probabilities: { misinformation: 0.92, factual: 0.05, irrelevant: 0.03 },
            entropy: 0.3,
          },
          truncated: false,
          latencyMs: spec.latencyMs ?? 90,
        };
  const classification = await ClassificationModel.create({
    postId: post._id,
    contract,
    modelName: normalized.modelName,
    modelVersion: normalized.modelVersion,
    taxonomyVersion: normalized.taxonomyVersion,
    textHash: textHash(text),
    isMock,
    output: null,
    normalized,
    isRelevant: true,
    stance: normalized.stance,
    topCategory: categories[0] ?? null,
    severityLevel: spec.finalSeverity ?? null,
    language: normalized.language,
    ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
  });
  const queue = spec.queue ?? 'review';
  const decision = await DecisionModel.create({
    postId: post._id,
    classificationId: classification._id,
    mode: 'dormant',
    inputHash: `seed-${n}`,
    isMisinformation: queue === 'review',
    finalSeverity: spec.finalSeverity === undefined ? 2 : spec.finalSeverity,
    reasons: ['seeded'],
    priorityScore: spec.priorityScore ?? 50,
    urgent: spec.urgent ?? false,
    queue,
    needsReview: false,
    rulesSnapshot: {
      mode: 'dormant',
      thresholds: Object.fromEntries(categories.map((c) => [c, 0.5])),
      floors: {},
    },
    isMock,
    ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
  });
  await PostModel.updateOne(
    { _id: post._id },
    {
      $set: {
        latestClassificationId: classification._id,
        latestDecisionId: decision._id,
        triage: {
          queue,
          finalSeverity: spec.finalSeverity === undefined ? 2 : spec.finalSeverity,
          priorityScore: spec.priorityScore ?? 50,
          urgent: spec.urgent ?? false,
          isMisinformation: queue === 'review',
          categories,
          topCategory: categories[0] ?? null,
          language: spec.language ?? 'en',
          stance: normalized.stance,
        },
      },
    },
  );
  return { post, classification, decision };
}
