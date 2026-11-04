import type { Citation } from '../../contracts/api/index.js';
import type { CounterNarrativeGenerator, GenerateRequest, GeneratedDraft } from './generator.js';

/**
 * Canned drafts, two variants per category so "regenerate" visibly changes the text. Plain-language public
 * health statements that stay general on purpose (no invented figures, notices or phone numbers).
 * Category ids are data from the taxonomy; unknown ids fall back to the generic statement.
 */
const CORE: Record<string, [string, string]> = {
  fake_cure_prevention: [
    'No home remedy prevents or cures Ebola. Drinking or bathing in salt water does not protect you and can harm you. Wash hands with soap and seek care early.',
    'Please do not share cure rumours. Salt water, herbs and other home treatments do not prevent or treat Ebola. Early care at a treatment centre saves lives.',
  ],
  transmission_misinfo: [
    'Ebola does not spread through the air like a cold. It spreads by direct contact with the blood or body fluids of a sick person, or with contaminated items.',
    'People with no symptoms do not spread Ebola. It passes through contact with blood or body fluids of someone who is sick or has died of it.',
  ],
  outbreak_denial: [
    'Ebola is a real disease confirmed by laboratory tests. Denying it puts families at risk. Follow guidance from NCDC and report fever with bleeding to a health facility.',
    'Laboratory tests confirm Ebola; it is not a rumour. Please follow official guidance and do not ignore warning signs in your family.',
  ],
  origin_conspiracy: [
    'Ebola is caused by a virus found in animals and was first identified in 1976. Rumours that it was made or spread on purpose are not supported by evidence.',
    'Scientists trace Ebola outbreaks to spillover from wild animals such as fruit bats. There is no evidence it was created or released deliberately.',
  ],
  response_distrust: [
    'Health workers and response teams are here to protect your community. Contact tracing helps stop the spread and keeps families safe. Please cooperate and ask questions.',
    'Response teams work to protect everyone. If you have concerns, ask the health team or your local leaders, and follow guidance from NCDC.',
  ],
  vaccine_trial_distrust: [
    'Vaccines and trials must be reviewed by independent ethics boards, and taking part is voluntary. Ask a health worker for information before deciding.',
    'Please get facts about vaccines and trials from NCDC and WHO. Taking part is a personal, voluntary choice made with full information.',
  ],
  burial_resistance: [
    'The body of a person who died of Ebola stays highly infectious. Safe and dignified burials by trained teams protect families and respect traditions. Please do not touch or wash the body.',
    'Safe and dignified burial protects your family from infection. Trained teams work with families to honour their loved ones safely.',
  ],
  stigma_discrimination: [
    'Survivors who have recovered are not a risk through everyday contact and need our support, not fear. Health workers are protecting us. Please do not shun them or their families.',
    'Stigma harms people and hides cases. Treat survivors, health workers and their families with respect, and follow health advice.',
  ],
  false_case_report: [
    'Please do not share unconfirmed reports of Ebola cases. Cases are confirmed by NCDC and state health authorities. Report suspected cases to the nearest health facility.',
    'Unverified case reports spread fear. Check official NCDC and state ministry of health channels before you share.',
  ],
  fake_official_notice: [
    'Please check this notice with official sources before sharing. Official announcements come from NCDC and your state ministry of health.',
    'Fake or altered notices spread fear. Confirm any notice on official NCDC channels before you forward it.',
  ],
  incitement_against_response: [
    'Attacking health workers or blocking response teams puts your whole community at risk. If you have concerns, raise them with local leaders and the health team.',
    'Response teams are here to help. Please let them work safely, and share worries through your local leaders and health facility.',
  ],
  other_ebola_misinfo: [
    'Please check Ebola information with NCDC or WHO before sharing. Wash hands with soap and water, avoid contact with the blood or body fluids of sick people, and report fever with bleeding.',
    'Before you share Ebola news, check it with NCDC or WHO. Wash your hands often and report fever with bleeding to a health facility.',
  ],
};

const SAFETY = 'Fever with bleeding? Go to a health facility or call the NCDC toll-free line.';
const SOURCES_SHORT = '(NCDC, WHO)';

const CITATIONS: Citation[] = [
  { source: 'NCDC', title: 'Nigeria Centre for Disease Control and Prevention', url: 'https://ncdc.gov.ng' },
  {
    source: 'WHO',
    title: 'Ebola virus disease (World Health Organization)',
    url: 'https://www.who.int/health-topics/ebola',
  },
];

/** Cuts at the last word boundary that leaves room for an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 1);
  const cut = text.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Joins the parts that fit, dropping optional ones in order (safety line first), and clipping as a last resort. */
export function fit(core: string, charLimit: number): string {
  const candidates = [`${core} ${SAFETY} ${SOURCES_SHORT}`, `${core} ${SOURCES_SHORT}`, core];
  for (const c of candidates) if (c.length <= charLimit) return c;
  // Even the core is too long: clip it but keep the source tag so the citation is never lost.
  const room = charLimit - SOURCES_SHORT.length - 1;
  return room > 20 ? `${clip(core, room)} ${SOURCES_SHORT}` : clip(core, charLimit);
}

/** Mock generator: canned text, deterministic, instant. Marked `mock` so the UI can never present it as real. */
export class MockGenerator implements CounterNarrativeGenerator {
  readonly mode = 'mock' as const;
  readonly name = 'mock-generator';
  readonly version = '0.0.0-mock';

  generate(req: GenerateRequest): Promise<GeneratedDraft> {
    const variants = (req.category && CORE[req.category]) || CORE.other_ebola_misinfo!;
    const core = variants[req.attempt % variants.length]!;
    const warnings: string[] = [];
    if (req.language !== 'en') {
      warnings.push(
        `The mock generator only drafts in English. A real generator would write in "${req.language}"; have a native speaker review it before dispatch.`,
      );
    }
    if (req.guidance)
      warnings.push('The mock generator ignores analyst guidance; a real generator would use it.');
    if (!req.category || !CORE[req.category])
      warnings.push('No category-specific draft: a general statement was used.');
    return Promise.resolve({
      text: fit(core, req.charLimit),
      language: 'en',
      citations: CITATIONS,
      warnings,
    });
  }
}
