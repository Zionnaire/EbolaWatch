import { EventEmitter } from 'node:events';
import type { TaxonomyDto } from '../contracts/api/index.js';
import { FIXTURES, loadFixture } from '../contracts/fixtures/index.js';
import { TaxonomySchema, type ModelTaxonomy } from '../contracts/model/multilabelV1.js';
import { THREECLASS_LABELS } from '../contracts/model/threeClassV0.js';
import { logger } from '../utils/logger.js';
import { modelHeaders, readErrorDetail } from './modelHttp.js';
import type { TaxonomyView } from './types.js';

export interface TaxonomySource {
  fetchTaxonomy(): Promise<TaxonomyDto>;
}

/** Persistence seam: Mongo in production, in-memory in unit tests. */
export interface TaxonomyRepo {
  save(t: TaxonomyDto): Promise<void>;
  loadLatest(): Promise<TaxonomyDto | null>;
  loadVersion(version: string): Promise<TaxonomyDto | null>;
}

export function toTaxonomyDto(t: ModelTaxonomy): TaxonomyDto {
  return {
    taxonomyVersion: t.taxonomy_version,
    categories: t.categories.map((c) => ({
      id: c.id,
      displayName: c.display_name,
      description: c.description,
    })),
    stances: t.stances.map((s) => ({ id: s.id, displayName: s.display_name })),
    languages: t.languages.map((l) => ({ id: l.id, displayName: l.display_name })),
    severityLevels: [...t.severity_levels],
  };
}

/**
 * The 3-class model has no taxonomy. We expose its labels through the same endpoint so the
 * UI can still resolve every label name from /api/taxonomy.
 */
export function threeClassTaxonomy(): TaxonomyDto {
  const names: Record<(typeof THREECLASS_LABELS)[number], [string, string]> = {
    misinformation: ['Misinformation', 'Content judged to be Ebola misinformation.'],
    factual: ['Factual', 'Accurate Ebola-related content.'],
    irrelevant: ['Irrelevant', 'Not related to Ebola.'],
  };
  return {
    taxonomyVersion: 'threeclass-v0',
    categories: THREECLASS_LABELS.map((id) => ({ id, displayName: names[id][0], description: names[id][1] })),
    stances: [],
    languages: [],
    severityLevels: [],
  };
}

export class FixtureTaxonomySource implements TaxonomySource {
  constructor(private readonly contract: 'multilabel-v1' | 'threeclass-v0') {}
  fetchTaxonomy(): Promise<TaxonomyDto> {
    return Promise.resolve(
      this.contract === 'threeclass-v0'
        ? threeClassTaxonomy()
        : toTaxonomyDto(TaxonomySchema.parse(loadFixture(FIXTURES.taxonomy))),
    );
  }
}

export class HttpTaxonomySource implements TaxonomySource {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly apiKey: string | null = null,
  ) {}

  async fetchTaxonomy(): Promise<TaxonomyDto> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/taxonomy`, {
      headers: modelHeaders(this.apiKey),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      throw new Error(`GET /v1/taxonomy failed: HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const parsed = TaxonomySchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`Taxonomy response failed validation: ${parsed.error.message}`);
    return toTaxonomyDto(parsed.data);
  }
}

export class MemoryTaxonomyRepo implements TaxonomyRepo {
  private readonly versions = new Map<string, TaxonomyDto>();
  private latest: TaxonomyDto | null = null;
  save(t: TaxonomyDto): Promise<void> {
    this.versions.set(t.taxonomyVersion, t);
    this.latest = t;
    return Promise.resolve();
  }
  loadLatest(): Promise<TaxonomyDto | null> {
    return Promise.resolve(this.latest);
  }
  loadVersion(version: string): Promise<TaxonomyDto | null> {
    return Promise.resolve(this.versions.get(version) ?? null);
  }
}

/** Holds the current taxonomy; syncs on startup and whenever the model reports a new version. */
export class TaxonomyService extends EventEmitter implements TaxonomyView {
  private current: TaxonomyDto | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly source: TaxonomySource,
    private readonly repo: TaxonomyRepo,
  ) {
    super();
  }

  /** Loads the stored copy first (so we can serve while the model is warming), then syncs. */
  async init(): Promise<void> {
    this.current = await this.repo.loadLatest().catch((err) => {
      logger.warn({ err }, 'could not load stored taxonomy');
      return null;
    });
    await this.resync().catch((err) => logger.warn({ err: String(err) }, 'initial taxonomy sync failed'));
  }

  get(): TaxonomyDto | null {
    return this.current;
  }

  version(): string | null {
    return this.current?.taxonomyVersion ?? null;
  }

  /** A specific version: the current one, or an older one kept in the repo (classifications cite their own version). */
  async getVersion(version: string): Promise<TaxonomyDto | null> {
    if (this.current?.taxonomyVersion === version) return this.current;
    return this.repo.loadVersion(version);
  }

  knownCategoryIds(): ReadonlySet<string> | null {
    return this.current ? new Set(this.current.categories.map((c) => c.id)) : null;
  }

  /** Concurrent callers share one in-flight sync. Rejects if the source is unreachable. */
  resync(): Promise<void> {
    this.inflight ??= this.doSync().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doSync(): Promise<void> {
    const fetched = await this.source.fetchTaxonomy();
    const changed = fetched.taxonomyVersion !== this.current?.taxonomyVersion;
    this.current = fetched;
    await this.repo.save(fetched);
    if (changed) {
      logger.info({ taxonomyVersion: fetched.taxonomyVersion }, 'taxonomy synced');
      this.emit('change', fetched);
    }
  }
}
