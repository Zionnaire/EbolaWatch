import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { KnowledgeDto } from '../contracts/api/index.js';

const FactSourceSchema = z.object({
  publisher: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  publishedAt: z.string().nullable().optional(),
  validUntil: z.string().optional(),
  license: z.string().optional(),
  verifiedAgainst: z.string().optional(),
});

const FactEntrySchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  text: z.string().min(10),
  source: z.string().min(1),
  volatile: z.boolean().default(false),
  asOf: z.string().optional(),
  validUntil: z.string().optional(),
  note: z.string().optional(),
});

export const FactFileSchema = z.object({
  version: z.string().min(1),
  retrievedAt: z.string(),
  status: z.enum(['pending_ncdc_review', 'approved']),
  note: z.string(),
  sources: z.record(z.string(), FactSourceSchema),
  entries: z.array(FactEntrySchema).min(1),
  gaps: z.array(z.string()).default([]),
});

export type FactSource = z.infer<typeof FactSourceSchema>;
export type FactEntry = z.infer<typeof FactEntrySchema>;
export type FactFile = z.infer<typeof FactFileSchema>;

/** A date like "2027-02-28" is valid through the end of that day (UTC). */
function endOfDay(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}

/**
 * The curated, source-attributed facts a counter-narrative may use. It refuses a file that references an unknown
 * source or repeats an id, and it hides entries past their validity date, so out-of-date guidance can never be
 * quoted. Whether the file has been signed off by NCDC is carried through so the UI and the writer can say so.
 */
export class FactBase {
  constructor(
    readonly file: FactFile,
    private readonly now: () => Date = () => new Date(),
  ) {
    const ids = new Set<string>();
    for (const e of file.entries) {
      if (ids.has(e.id)) throw new Error(`Fact base: duplicate entry id "${e.id}"`);
      ids.add(e.id);
      if (!file.sources[e.source])
        throw new Error(`Fact base: entry "${e.id}" cites unknown source "${e.source}"`);
    }
  }

  static fromFile(path: string, now?: () => Date): FactBase {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(
        `Cannot read the fact base at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = FactFileSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Invalid fact base ${path}: ${issue?.path.join('.')} ${issue?.message}`);
    }
    return new FactBase(parsed.data, now);
  }

  get status() {
    return this.file.status;
  }
  get version() {
    return this.file.version;
  }

  sourceOf(entry: FactEntry): FactSource {
    return this.file.sources[entry.source]!;
  }

  /** The entry's own validity date, else its source's. */
  validUntil(entry: FactEntry): string | null {
    return entry.validUntil ?? this.sourceOf(entry).validUntil ?? null;
  }

  isExpired(entry: FactEntry): boolean {
    const until = this.validUntil(entry);
    return until !== null && this.now().getTime() > endOfDay(until);
  }

  /** Entries the writer may use right now. */
  usable(): FactEntry[] {
    return this.file.entries.filter((e) => !this.isExpired(e));
  }

  toDto(): KnowledgeDto {
    return {
      version: this.file.version,
      status: this.file.status,
      retrievedAt: this.file.retrievedAt,
      note: this.file.note,
      gaps: this.file.gaps,
      entries: this.file.entries.map((e) => {
        const s = this.sourceOf(e);
        return {
          id: e.id,
          topic: e.topic,
          text: e.text,
          volatile: e.volatile,
          asOf: e.asOf ?? null,
          validUntil: this.validUntil(e),
          expired: this.isExpired(e),
          note: e.note ?? null,
          source: { publisher: s.publisher, title: s.title, url: s.url },
        };
      }),
    };
  }
}
