/**
 * The only place severity looks and wording are defined. Severity is never colour alone: every level has its own
 * glyph shape and a text label, so it still reads in greyscale and for colour-blind analysts.
 */
import type { SeverityLevel } from '@/contracts';

export type SeverityGlyph = 'ring' | 'dot' | 'triangle' | 'diamond' | 'burst';

export interface SeverityStyle {
  level: SeverityLevel;
  label: string;
  /** One line for tooltips and reasoning text. */
  meaning: string;
  glyph: SeverityGlyph;
  /** CSS custom properties (defined in styles/tokens.css). */
  color: string;
  tint: string;
}

export const SEVERITY: Record<SeverityLevel, SeverityStyle> = {
  0: {
    level: 0,
    label: 'None',
    meaning: 'Not misinformation',
    glyph: 'ring',
    color: 'var(--sev-0)',
    tint: 'var(--sev-0-tint)',
  },
  1: {
    level: 1,
    label: 'Low',
    meaning: 'Minor inaccuracy, little risk to health',
    glyph: 'dot',
    color: 'var(--sev-1)',
    tint: 'var(--sev-1-tint)',
  },
  2: {
    level: 2,
    label: 'Moderate',
    meaning: 'Misleading claim that could change behaviour',
    glyph: 'triangle',
    color: 'var(--sev-2)',
    tint: 'var(--sev-2-tint)',
  },
  3: {
    level: 3,
    label: 'High',
    meaning: 'Harmful claim that is spreading or sounds credible',
    glyph: 'diamond',
    color: 'var(--sev-3)',
    tint: 'var(--sev-3-tint)',
  },
  4: {
    level: 4,
    label: 'Critical',
    meaning: 'Dangerous advice or a panic-inducing falsehood',
    glyph: 'burst',
    color: 'var(--sev-4)',
    tint: 'var(--sev-4-tint)',
  },
};

export const SEVERITY_LEVELS: SeverityLevel[] = [0, 1, 2, 3, 4];

export const severityOf = (level: SeverityLevel | null | undefined): SeverityStyle | null =>
  level === null || level === undefined ? null : SEVERITY[level];
