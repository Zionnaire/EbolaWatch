import type { ModelStatusStore } from '../classifier/modelStatus.js';
import { classifierProvenance } from '../classifier/provenance.js';
import type { ClassifierClient, ModelIdentity } from '../classifier/types.js';
import type { Config } from '../config.js';
import type { DataSource, OperatingMode, SystemStatus } from '../contracts/api/index.js';

export interface SystemStatusDeps {
  config: Pick<Config, 'MODEL_MODE' | 'MODEL_CONTRACT' | 'INGESTION_MODE' | 'MODEL_MOCK_MARKER'>;
  store: ModelStatusStore;
  classifier: Pick<ClassifierClient, 'kind'>;
  /** Mutable holder updated from the classifier's onModelIdentity hook. */
  identity: { current: ModelIdentity | null };
  operatingMode: () => OperatingMode;
  // TODO(B5): real providers; both are mocked until the generator and dispatcher exist.
  generator?: DataSource['generator'];
  dispatcher?: DataSource['dispatcher'];
}

/** Single place that answers "what is real and what is mock right now?". Reaches the client via /api/system/status. */
export function buildSystemStatus(d: SystemStatusDeps): SystemStatus {
  const s = d.store.get();
  // Until a classify response has named the model, /v1/health's model_version is the best identity we have.
  const identity =
    d.identity.current ??
    (s.modelVersion ? { name: '', version: s.modelVersion, taxonomyVersion: s.taxonomyVersion } : null);
  return {
    modelMode: d.config.MODEL_MODE,
    modelContract: d.config.MODEL_CONTRACT,
    dataSource: {
      ingestion: d.config.INGESTION_MODE,
      classifier: classifierProvenance(d.classifier.kind, identity, d.config.MODEL_MOCK_MARKER),
      generator: d.generator ?? 'mock',
      dispatcher: d.dispatcher ?? 'mock',
    },
    modelStatus: s.status,
    modelVersion: s.modelVersion,
    taxonomyVersion: s.taxonomyVersion,
    operatingMode: d.operatingMode(),
    retryAvailableAt: s.retryAvailableAt,
  };
}
