import { Chip, SeverityBadge } from '@/components/ui';
import { PIPELINE, REVIEW, label } from '@/config/status';
import type { PostDto } from '@/contracts';
import type { Names } from '@/hooks/useNames';
import { prettify } from '@/utils/format';
import { primaryLabel } from '@/utils/post';

/** Urgent, overdue and mock markers for a post, each with text (never colour alone). */
export function PostFlags({ post }: { post: PostDto }) {
  return (
    <>
      {post.decision?.urgent && (
        <Chip tone="urgent" icon="flag">
          Urgent
        </Chip>
      )}
      {post.overdue && (
        <Chip tone="overdue" icon="clock">
          Overdue
        </Chip>
      )}
      {post.isMock && <Chip tone="mock">Mock</Chip>}
    </>
  );
}

/** Where a post stands: severity if it was rated, otherwise the pipeline state in words. */
export function PostRating({ post }: { post: PostDto }) {
  if (post.decision) return <SeverityBadge level={post.decision.finalSeverity} />;
  return (
    <Chip tone={post.pipelineStatus === 'classification_error' ? 'bad' : 'wait'}>
      {label(PIPELINE, post.pipelineStatus)}
    </Chip>
  );
}

export function PostLabel({ post, names }: { post: PostDto; names: Names }) {
  const p = primaryLabel(post);
  if (!p) return <span className="faint">—</span>;
  if (p.kind === 'class') return <span>{prettify(p.id)}</span>;
  return (
    <span>
      {names.category(p.id)}
      {post.classification?.stance && (
        <span className="faint small"> · {names.stance(post.classification.stance)}</span>
      )}
    </span>
  );
}

export const reviewLabel = (s: PostDto['reviewStatus']) => REVIEW[s];
