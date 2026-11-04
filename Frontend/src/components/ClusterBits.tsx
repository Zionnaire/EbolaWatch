import { Chip } from '@/components/ui';
import type { ClusterDto } from '@/contracts';

/** Trend as words and an arrow, never colour alone. */
export function TrendChip({ c }: { c: Pick<ClusterDto, 'trend' | 'changePct' | 'previousCount'> }) {
  switch (c.trend) {
    case 'new':
      return (
        <Chip tone="warn" icon="spark" title="Not seen last week">
          New
        </Chip>
      );
    case 'rising':
      return (
        <Chip tone="bad" icon="arrowUp" title={`${c.previousCount} last week`}>
          Rising{c.changePct !== null ? ` ${Math.round(c.changePct)}%` : ''}
        </Chip>
      );
    case 'falling':
      return (
        <Chip tone="ok" icon="arrowDown" title={`${c.previousCount} last week`}>
          Falling{c.changePct !== null ? ` ${Math.abs(Math.round(c.changePct))}%` : ''}
        </Chip>
      );
    default:
      return (
        <Chip tone="plain" title={`${c.previousCount} last week`}>
          Steady
        </Chip>
      );
  }
}

/** Marks a title that an AI wrote, so nobody mistakes it for something an analyst checked. */
export function AiNamed({ c }: { c: Pick<ClusterDto, 'labelSource'> }) {
  return c.labelSource === 'ai' ? (
    <Chip
      tone="plain"
      icon="spark"
      title="Named by an AI model from the sample posts. Check it against them."
    >
      AI-named
    </Chip>
  ) : null;
}
