import { describe, expect, it } from 'vitest';
import {
  ClassificationSchema,
  SocketEventSchemas,
  SystemStatusSchema,
  mockStages,
} from '../src/contracts/api/index.js';

const classification = {
  contract: 'multilabel-v1',
  modelName: 'mock-ebola-clf',
  modelVersion: '0.0.0-mock',
  taxonomyVersion: 'ebola-tax-1.0',
  isRelevant: true,
  relevanceConfidence: 0.9,
  language: 'pcm',
  stance: 'endorses',
  categories: [{ label: 'fake_cure_prevention', score: 0.88 }],
  severity: { level: 4, confidence: 0.7, distribution: [0.02, 0.03, 0.06, 0.15, 0.74] },
  threeClass: null,
  truncated: false,
  latencyMs: 120,
};

describe('internal API contracts', () => {
  it('Classification accepts a multilabel and a three-class shape', () => {
    expect(ClassificationSchema.safeParse(classification).success).toBe(true);
    const threeClass = {
      ...classification,
      contract: 'threeclass-v0',
      taxonomyVersion: null,
      stance: null,
      categories: [],
      severity: null,
      threeClass: {
        label: 'misinformation',
        probabilities: { misinformation: 0.9, factual: 0.05, irrelevant: 0.05 },
        entropy: 0.3,
      },
    };
    expect(ClassificationSchema.safeParse(threeClass).success).toBe(true);
  });

  it('SystemStatus requires provenance for every stage', () => {
    const status = {
      modelMode: 'mock',
      modelContract: 'multilabel-v1',
      dataSource: { ingestion: 'mock', classifier: 'mock-server', generator: 'mock', dispatcher: 'mock' },
      modelStatus: 'warming',
      modelVersion: null,
      taxonomyVersion: null,
      operatingMode: 'dormant',
      retryAvailableAt: '2026-10-27T12:00:20.000Z',
    };
    expect(SystemStatusSchema.safeParse(status).success).toBe(true);
    const missing = { ...status, dataSource: { ingestion: 'mock' } };
    expect(SystemStatusSchema.safeParse(missing).success).toBe(false);
  });

  it('mockStages names every non-live stage', () => {
    expect(
      mockStages({ ingestion: 'push', classifier: 'live', generator: 'live', dispatcher: 'live' }),
    ).toEqual([]);
    expect(
      mockStages({ ingestion: 'mock', classifier: 'mock-server', generator: 'live', dispatcher: 'mock' }),
    ).toEqual(['ingestion', 'classifier', 'dispatcher']);
  });

  it('defines the four socket events', () => {
    expect(Object.keys(SocketEventSchemas).sort()).toEqual([
      'alert',
      'model:status',
      'post:classified',
      'system:update',
    ]);
  });
});
