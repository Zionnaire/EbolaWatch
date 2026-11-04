import type { DataSource } from '../contracts/api/index.js';

/**
 * Mock data must never mix with real data. A run is "mock" when ingestion is synthetic or the classifier
 * is not the live model; every post and classification is stamped with this, and API queries are scoped to it.
 * (The generator and dispatcher do not affect stored posts, so they are not part of the scope.)
 */
export function runIsMock(ds: Pick<DataSource, 'ingestion' | 'classifier'>): boolean {
  return ds.ingestion === 'mock' || ds.classifier !== 'live';
}

export function classifierIsMock(classifier: DataSource['classifier']): boolean {
  return classifier !== 'live';
}
