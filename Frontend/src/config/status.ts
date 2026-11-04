/** Wording for backend states that are data (statuses, modes). Unknown values fall back to a prettified id. */
import type { ModelStatus, NarrativeStatus, PipelineStatus, ReviewStatus } from '@/contracts';
import { prettify } from '@/utils/format';

export type Tone = 'ok' | 'wait' | 'warn' | 'bad' | 'idle';

export const MODEL_STATUS: Record<ModelStatus, { label: string; tone: Tone }> = {
  ready: { label: 'Model ready', tone: 'ok' },
  // warming is a normal, neutral state: never styled as an error
  warming: { label: 'Model warming up', tone: 'wait' },
  degraded: { label: 'Model degraded', tone: 'warn' },
  error: { label: 'Model unreachable', tone: 'bad' },
  unknown: { label: 'Model status unknown', tone: 'idle' },
};

export const PIPELINE: Record<PipelineStatus, string> = {
  pending: 'Waiting to be classified',
  classifying: 'Being classified',
  classified: 'Classified',
  needs_review: 'Needs a closer look',
  classification_error: 'Could not be classified',
};

export const REVIEW: Record<ReviewStatus, string> = {
  unreviewed: 'Not reviewed',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  corrected: 'Corrected',
};

export const NARRATIVE: Record<NarrativeStatus, { label: string; tone: Tone | 'done' }> = {
  draft: { label: 'Draft', tone: 'idle' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  dispatching: { label: 'Sending', tone: 'wait' },
  dispatched: { label: 'Sent', tone: 'done' },
};

export const label = (map: Record<string, string>, key: string) => map[key] ?? prettify(key);

export const OPERATING_MODE = {
  dormant: { label: 'Dormant', hint: 'Higher thresholds. Only clear cases reach the queue.' },
  surge: { label: 'Surge', hint: 'Lower thresholds. More posts reach the queue during an outbreak.' },
} as const;

export const ROLE_LABEL: Record<string, string> = {
  analyst: 'Analyst',
  senior_analyst: 'Senior analyst',
  supervisor: 'Supervisor',
  org_admin: 'Organization admin',
  super_admin: 'Platform operator',
};

export const ORG_TYPE_LABEL: Record<string, string> = {
  national: 'National',
  state: 'State team',
  partner: 'Partner',
};

export const ORG_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  trial: 'Trial',
  suspended: 'Suspended',
};

export const STAGE_LABEL: Record<string, string> = {
  ingestion: 'post feed',
  classifier: 'classifier',
  generator: 'counter-narrative writer',
  dispatcher: 'dispatcher',
};
