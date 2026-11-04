import type { DataSource } from '../contracts/api/index.js';
import type { ModelIdentity } from './types.js';

/** True when the model identifies itself as a mock/staging stand-in via name or version. */
export function matchesMockMarker(model: Pick<ModelIdentity, 'name' | 'version'>, marker: string): boolean {
  const m = marker.toLowerCase();
  return model.name.toLowerCase().includes(m) || model.version.toLowerCase().includes(m);
}

/**
 * Honest classifier provenance. In-process is always `mock-inprocess`. Over HTTP we trust what the model
 * says about itself, not our config: a mock server reached in `live` mode is still reported as mock.
 * Before the model has identified itself we cannot claim `live`, so we assume mock.
 */
export function classifierProvenance(
  kind: 'inprocess' | 'http',
  identity: Pick<ModelIdentity, 'name' | 'version'> | null,
  marker: string,
): DataSource['classifier'] {
  if (kind === 'inprocess') return 'mock-inprocess';
  if (!identity) return 'mock-server';
  return matchesMockMarker(identity, marker) ? 'mock-server' : 'live';
}

/**
 * Is the classifier KNOWN to be a mock? Unlike `classifierProvenance` (which assumes mock until the model has
 * identified itself, so the UI cannot lie), this is false when we simply do not know yet: it is used to stamp
 * new data provisionally, and the stamp is corrected when the post is classified.
 */
export function classifierKnownMock(
  kind: 'inprocess' | 'http',
  identity: Pick<ModelIdentity, 'name' | 'version'> | null,
  marker: string,
): boolean {
  if (kind === 'inprocess') return true;
  return identity !== null && matchesMockMarker(identity, marker);
}
