/**
 * Pure decision logic: Classification + rules + operating mode -> Decision. No I/O, no clock, no logging.
 * Callers log `rulelessCategories` and act on `needsReview`.
 */
import type {
  Classification,
  OperatingMode,
  Queue,
  RulesConfig,
  SeverityLevel,
} from '../contracts/api/index.js';

export interface Engagement {
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  views?: number | null;
}

export interface DecisionInput {
  classification: Classification;
  /** Scrubbed post text, used by keyword rules. */
  text: string;
  engagement: Engagement | null;
  /** Category labels the classifier returned that are absent from the synced taxonomy. */
  unknownLabels: string[];
}

export interface DecisionResult {
  isMisinformation: boolean;
  finalSeverity: SeverityLevel | null;
  reasons: string[];
  priorityScore: number;
  urgent: boolean;
  queue: Queue;
  /** An unknown category label was seen: the post is flagged `needs_review`. */
  needsReview: boolean;
  /** Categories scored but absent from the rules: they used the default threshold and floor 0. */
  rulelessCategories: string[];
  rulesSnapshot: Record<string, unknown>;
}

const clampSeverity = (n: number): SeverityLevel => Math.min(4, Math.max(0, Math.round(n))) as SeverityLevel;
const pct = (n: number) => n.toFixed(2);

function thresholdFor(rules: RulesConfig, label: string, mode: OperatingMode): number {
  return (rules.categories[label]?.thresholds ?? rules.defaultThresholds)[mode];
}

/** TODO: replace with real scoring. Placeholder from final severity, engagement and urgency. */
export function priorityScore(
  finalSeverity: SeverityLevel | null,
  urgent: boolean,
  engagement: Engagement | null,
): number {
  if (finalSeverity === null) return 0;
  const e = engagement;
  const reach = e ? (e.likes ?? 0) + 2 * (e.reposts ?? 0) + (e.replies ?? 0) : 0;
  const engagementScore = Math.min(25, Math.round(Math.log10(1 + Math.max(0, reach)) * 8));
  return finalSeverity * 20 + (urgent ? 25 : 0) + engagementScore;
}

function snapshot(
  rules: RulesConfig,
  mode: OperatingMode,
  c: Classification,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const labels = c.categories.map((x) => x.label);
  return {
    mode,
    contract: c.contract,
    taxonomyVersion: rules.taxonomyVersion,
    rulesUpdatedAt: rules.updatedAt,
    thresholds: Object.fromEntries(labels.map((l) => [l, thresholdFor(rules, l, mode)])),
    floors: Object.fromEntries(labels.map((l) => [l, rules.categories[l]?.floor ?? 0])),
    keywordRules: rules.keywordRules,
    confidenceBands: rules.confidenceBands,
    threeClassSeverity: rules.threeClassSeverity,
    urgentSeverityMin: rules.urgentSeverityMin,
    ...extra,
  };
}

const none = (
  reasons: string[],
  snap: Record<string, unknown>,
  input: DecisionInput,
  queue: Queue = 'none',
): DecisionResult => ({
  isMisinformation: false,
  finalSeverity: null,
  reasons,
  priorityScore: queue === 'information_gap' ? 5 : 0,
  urgent: false,
  queue,
  needsReview: input.unknownLabels.length > 0,
  rulelessCategories: [],
  rulesSnapshot: snap,
});

export function decide(input: DecisionInput, rules: RulesConfig, mode: OperatingMode): DecisionResult {
  const c = input.classification;
  const snap = snapshot(rules, mode, c);

  if (!c.isRelevant) return none(['Not related to Ebola.'], snap, input);

  const unknownNote =
    input.unknownLabels.length > 0
      ? [`Unknown category label(s) from the model: ${input.unknownLabels.join(', ')}. Needs review.`]
      : [];

  const result =
    c.contract === 'threeclass-v0'
      ? decideThreeClass(input, rules, snap)
      : decideMultilabel(input, rules, mode, snap);
  return {
    ...result,
    needsReview: input.unknownLabels.length > 0,
    reasons: [...result.reasons, ...unknownNote],
  };
}

function decideMultilabel(
  input: DecisionInput,
  rules: RulesConfig,
  mode: OperatingMode,
  snap: Record<string, unknown>,
): DecisionResult {
  const c = input.classification;
  const rulelessCategories = c.categories.map((x) => x.label).filter((l) => !(l in rules.categories));
  const over = c.categories.filter((x) => x.score >= thresholdFor(rules, x.label, mode));
  const endorses = c.stance === 'endorses';

  if (endorses && over.length > 0) {
    const reasons: string[] = [];
    const modelSeverity = c.severity?.level ?? 0;
    reasons.push(c.severity ? `Model severity ${modelSeverity}.` : 'Model gave no severity (counted as 0).');
    const floors = over.map((x) => {
      const floor = rules.categories[x.label]?.floor ?? 0;
      reasons.push(
        `Category "${x.label}" scored ${pct(x.score)} (threshold ${pct(thresholdFor(rules, x.label, mode))}, ${mode} mode); severity floor ${floor}.`,
      );
      return floor;
    });
    const keywordHits = rules.keywordRules.filter((k) => new RegExp(k.pattern, k.flags).test(input.text));
    for (const k of keywordHits) reasons.push(`Keyword rule "${k.id}" matched; severity ${k.severity}.`);

    const finalSeverity = clampSeverity(
      Math.max(modelSeverity, ...floors, ...keywordHits.map((k) => k.severity)),
    );
    const urgent = finalSeverity >= rules.urgentSeverityMin;
    reasons.push(`Final severity ${finalSeverity}${urgent ? ' (urgent)' : ''}.`);
    return {
      isMisinformation: true,
      finalSeverity,
      reasons,
      priorityScore: priorityScore(finalSeverity, urgent, input.engagement),
      urgent,
      queue: 'review',
      needsReview: false,
      rulelessCategories,
      rulesSnapshot: { ...snap, keywordMatches: keywordHits.map((k) => k.id) },
    };
  }

  if (c.stance === 'questions') {
    return {
      ...none(
        ['Relevant post that asks a question: an information gap, not misinformation.'],
        snap,
        input,
        'information_gap',
      ),
      rulelessCategories,
    };
  }

  const why = !endorses
    ? `Stance is ${c.stance ?? 'unknown'}, not endorsing.`
    : 'No category reached its threshold.';
  return { ...none([why], snap, input), rulelessCategories };
}

function decideThreeClass(
  input: DecisionInput,
  rules: RulesConfig,
  snap: Record<string, unknown>,
): DecisionResult {
  const tc = input.classification.threeClass;
  if (!tc) return none(['No three-class output on this classification.'], snap, input);
  const confidence = tc.probabilities.misinformation;
  const { standard, urgent: urgentBand } = rules.confidenceBands;

  if (tc.label === 'misinformation' && confidence >= standard) {
    const urgent = confidence >= urgentBand;
    const finalSeverity = urgent ? rules.threeClassSeverity.urgent : rules.threeClassSeverity.standard;
    return {
      isMisinformation: true,
      finalSeverity,
      reasons: [
        `Predicted misinformation at ${pct(confidence)} (standard band ${pct(standard)}, urgent band ${pct(urgentBand)}).`,
        `Severity ${finalSeverity} from the ${urgent ? 'urgent' : 'standard'} band (placeholder mapping).`,
      ],
      priorityScore: priorityScore(finalSeverity, urgent, input.engagement),
      urgent,
      queue: 'review',
      needsReview: false,
      rulelessCategories: [],
      rulesSnapshot: snap,
    };
  }
  const reason =
    tc.label === 'misinformation'
      ? `Predicted misinformation at ${pct(confidence)}, below the standard band ${pct(standard)}: stored, not queued.`
      : `Predicted ${tc.label}.`;
  return none([reason], snap, input);
}
