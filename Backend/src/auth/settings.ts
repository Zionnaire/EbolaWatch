import type { EffectiveSettings, OrgSettingsPatch } from '../contracts/api/index.js';

type Stored =
  { overdueHours?: number; queueCap?: number; vocabulary?: Record<string, string> } | null | undefined;

/** An organization inherits any field it has not set from the platform defaults. */
export function resolveSettings(stored: Stored, defaults: EffectiveSettings): EffectiveSettings {
  return {
    overdueHours: stored?.overdueHours ?? defaults.overdueHours,
    queueCap: stored?.queueCap ?? defaults.queueCap,
    vocabulary: { ...defaults.vocabulary, ...(stored?.vocabulary ?? {}) },
  };
}

/**
 * Applies a validated patch to stored settings: a value sets a field, `null` clears it (back to inheriting),
 * and a field that is absent is left alone. Only whitelisted fields can ever reach the database.
 */
export function applySettingsPatch(stored: Stored, patch: OrgSettingsPatch): NonNullable<Stored> {
  const next: NonNullable<Stored> = { ...(stored ?? {}) };
  if (patch.overdueHours !== undefined) {
    if (patch.overdueHours === null) delete next.overdueHours;
    else next.overdueHours = patch.overdueHours;
  }
  if (patch.queueCap !== undefined) {
    if (patch.queueCap === null) delete next.queueCap;
    else next.queueCap = patch.queueCap;
  }
  if (patch.vocabulary !== undefined) {
    if (patch.vocabulary === null) delete next.vocabulary;
    else next.vocabulary = patch.vocabulary;
  }
  return next;
}
