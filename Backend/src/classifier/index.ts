import type { Config } from '../config.js';
import { HttpClassifier } from './httpClassifier.js';
import { HttpHealthSource } from './httpHealthSource.js';
import { InProcessMockClassifier } from './inProcessMock.js';
import {
  InProcessHealthSource,
  ModelStatusPoller,
  ModelStatusStore,
  type HealthSource,
} from './modelStatus.js';
import {
  FixtureTaxonomySource,
  HttpTaxonomySource,
  TaxonomyService,
  type TaxonomyRepo,
  type TaxonomySource,
} from './taxonomy.js';
import type { ClassifierClient, ClassifierHooks, ModelIdentity } from './types.js';

export interface ClassifierStack {
  client: ClassifierClient;
  taxonomy: TaxonomyService;
  store: ModelStatusStore;
  poller: ModelStatusPoller;
  identity: { current: ModelIdentity | null };
}

type ClassifierConfig = Pick<
  Config,
  'MODEL_MODE' | 'MODEL_CONTRACT' | 'MODEL_BASE_URL' | 'MODEL_TIMEOUT_MS' | 'MODEL_WARMUP_MAX_WAIT_MS'
> &
  Partial<Pick<Config, 'MODEL_API_KEY' | 'MODEL_MAX_TEXT_CHARS'>>;

/**
 * MODEL_MODE=mock -> in-process fixtures, no network.
 * MODEL_MODE=live -> HTTP to MODEL_BASE_URL (which may itself be the mock-model server; provenance is
 * decided from what the model says about itself, not from this flag).
 */
export function buildClassifierStack(
  config: ClassifierConfig,
  repo: TaxonomyRepo,
  onAlert: ClassifierHooks['onAlert'],
): ClassifierStack {
  const store = new ModelStatusStore();
  const identity: ClassifierStack['identity'] = { current: null };
  const hooks: ClassifierHooks = {
    onModelIdentity: (m) => {
      identity.current = m;
    },
    onModelStatus: (s) => {
      if (s.status === 'ready') store.markClassifySuccess();
      else store.update({ status: s.status, retryAvailableAt: s.retryAvailableAt, detail: s.detail });
    },
    onAlert,
  };

  const live = config.MODEL_MODE === 'live';
  const taxonomySource: TaxonomySource = live
    ? config.MODEL_CONTRACT === 'multilabel-v1'
      ? new HttpTaxonomySource(
          config.MODEL_BASE_URL,
          config.MODEL_TIMEOUT_MS,
          undefined,
          config.MODEL_API_KEY ?? null,
        )
      : new FixtureTaxonomySource('threeclass-v0') // the 3-class model has no /v1/taxonomy
    : new FixtureTaxonomySource(config.MODEL_CONTRACT);
  const taxonomy = new TaxonomyService(taxonomySource, repo);

  const client: ClassifierClient = live
    ? new HttpClassifier(
        {
          baseUrl: config.MODEL_BASE_URL,
          contract: config.MODEL_CONTRACT,
          timeoutMs: config.MODEL_TIMEOUT_MS,
          warmupMaxWaitMs: config.MODEL_WARMUP_MAX_WAIT_MS,
          apiKey: config.MODEL_API_KEY ?? null,
          maxTextChars: config.MODEL_MAX_TEXT_CHARS,
        },
        taxonomy,
        hooks,
      )
    : new InProcessMockClassifier(config.MODEL_CONTRACT, taxonomy, hooks);

  const source: HealthSource = live
    ? new HttpHealthSource(
        config.MODEL_BASE_URL,
        config.MODEL_TIMEOUT_MS,
        undefined,
        config.MODEL_API_KEY ?? null,
      )
    : new InProcessHealthSource(config.MODEL_CONTRACT === 'multilabel-v1' ? 'ebola-tax-1.0' : null);
  const poller = new ModelStatusPoller(source, store, taxonomy, {
    intervalMs: 15_000,
    syncsTaxonomy: live && config.MODEL_CONTRACT === 'multilabel-v1',
  });

  return { client, taxonomy, store, poller, identity };
}
