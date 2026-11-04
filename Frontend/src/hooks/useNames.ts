import { useMemo } from 'react';
import { useSystemStatus, useTaxonomyQuery } from '@/api/queries';
import type { TaxonomyDto } from '@/contracts';
import { prettify } from '@/utils/format';

export interface Names {
  ready: boolean;
  category: (id: string) => string;
  categoryHint: (id: string) => string | null;
  stance: (id: string | null | undefined) => string;
  language: (id: string | null | undefined) => string;
  platform: (id: string) => string;
  taxonomy: TaxonomyDto | undefined;
}

const lookup = <T extends { id: string }>(rows: T[] | undefined, pick: (r: T) => string) => {
  const map = new Map((rows ?? []).map((r) => [r.id, pick(r)] as const));
  return (id: string | null | undefined) => (id ? (map.get(id) ?? prettify(id)) : '—');
};

/**
 * Every category, stance and language name comes from /api/taxonomy, looked up by the taxonomy version the
 * classification was made with (pass it in), falling back to the current taxonomy and then to the prettified id.
 * Components never carry label strings of their own.
 */
export function useNames(taxonomyVersion?: string | null): Names {
  const status = useSystemStatus();
  const current = useTaxonomyQuery();
  const wanted = taxonomyVersion && taxonomyVersion !== status.data?.taxonomyVersion ? taxonomyVersion : null;
  const specific = useTaxonomyQuery(wanted);

  const primary = wanted ? specific.data : undefined;
  const cur = current.data;

  return useMemo(() => {
    const cat = lookup(primary?.categories ?? cur?.categories, (c) => c.displayName);
    const fallbackCat = lookup(cur?.categories, (c) => c.displayName);
    const hints = new Map(
      [...(cur?.categories ?? []), ...(primary?.categories ?? [])].map((c) => [c.id, c.description] as const),
    );
    const stance = lookup(primary?.stances ?? cur?.stances, (s) => s.displayName);
    const language = lookup(primary?.languages ?? cur?.languages, (l) => l.displayName);
    return {
      ready: !!cur,
      category: (id) => {
        const v = cat(id);
        return v === prettify(id) ? fallbackCat(id) : v;
      },
      categoryHint: (id) => hints.get(id) ?? null,
      stance,
      language,
      platform: (id) => prettify(id),
      taxonomy: primary ?? cur,
    };
  }, [primary, cur]);
}
