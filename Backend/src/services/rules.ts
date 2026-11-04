import type { Contract, RulesConfig } from '../contracts/api/index.js';
import { RulesConfigSchema } from '../contracts/api/index.js';
import { logger } from '../utils/logger.js';

/** §9 category severity floors for taxonomy `ebola-tax-1.0`. Seed data: live values are read from the DB. */
export const DEFAULT_CATEGORY_FLOORS: Record<string, 0 | 1 | 2 | 3 | 4> = {
  fake_cure_prevention: 3,
  transmission_misinfo: 2,
  outbreak_denial: 2,
  origin_conspiracy: 2,
  response_distrust: 3,
  vaccine_trial_distrust: 2,
  burial_resistance: 3,
  stigma_discrimination: 2,
  false_case_report: 2,
  fake_official_notice: 3,
  incitement_against_response: 4,
  other_ebola_misinfo: 1,
};

/** The rules key: the taxonomy version, or the contract name for the taxonomy-less 3-class model. */
export const rulesKey = (contract: Contract, taxonomyVersion: string | null): string =>
  contract === 'threeclass-v0' ? 'threeclass-v0' : (taxonomyVersion ?? 'unversioned');

export function defaultRules(
  contract: Contract,
  taxonomyVersion: string | null,
  categoryIds: string[] = Object.keys(DEFAULT_CATEGORY_FLOORS),
): RulesConfig {
  return RulesConfigSchema.parse({
    taxonomyVersion: rulesKey(contract, taxonomyVersion),
    contract,
    defaultThresholds: { dormant: 0.5, surge: 0.4 },
    // Only categories we have a floor for get an entry; the rest fall back to the default (logged by the caller).
    categories: Object.fromEntries(
      categoryIds
        .filter((id) => id in DEFAULT_CATEGORY_FLOORS)
        .map((id) => [id, { floor: DEFAULT_CATEGORY_FLOORS[id] }]),
    ),
    keywordRules: [], // fully wired in the engine; intentionally empty for now
    confidenceBands: { urgent: 0.9, standard: 0.75 },
    // TODO(ext): placeholder mapping until NCDC defines severity for the 3-class model
    threeClassSeverity: { urgent: 3, standard: 2 },
    urgentSeverityMin: 4,
    updatedAt: new Date().toISOString(),
  });
}

export interface RulesRepo {
  get(key: string): Promise<RulesConfig | null>;
  save(rules: RulesConfig): Promise<void>;
  list(): Promise<RulesConfig[]>;
}

export class MemoryRulesRepo implements RulesRepo {
  private readonly rows = new Map<string, RulesConfig>();
  get(key: string): Promise<RulesConfig | null> {
    return Promise.resolve(this.rows.get(key) ?? null);
  }
  save(rules: RulesConfig): Promise<void> {
    this.rows.set(rules.taxonomyVersion, rules);
    return Promise.resolve();
  }
  list(): Promise<RulesConfig[]> {
    return Promise.resolve([...this.rows.values()]);
  }
}

/** Reads rules from the repo, seeding defaults the first time a taxonomy version is seen. Settings stay data. */
export class RulesService {
  constructor(private readonly repo: RulesRepo) {}

  async getFor(
    contract: Contract,
    taxonomyVersion: string | null,
    categoryIds?: string[],
  ): Promise<RulesConfig> {
    const key = rulesKey(contract, taxonomyVersion);
    const existing = await this.repo.get(key);
    if (existing) return existing;
    const seeded = defaultRules(contract, taxonomyVersion, categoryIds);
    const missing = (categoryIds ?? []).filter((id) => !(id in seeded.categories));
    if (missing.length > 0) {
      logger.warn(
        { key, categories: missing },
        'no rule for some categories: default threshold and floor 0 apply',
      );
    }
    await this.repo.save(seeded);
    logger.info({ key }, 'seeded default rules');
    return seeded;
  }

  list(): Promise<RulesConfig[]> {
    return this.repo.list();
  }
}
