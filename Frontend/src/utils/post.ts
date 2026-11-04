import type { PostDto } from '@/contracts';

/** The highest-scoring category of a classification, or null (3-class posts and unclassified posts have none). */
export function topCategory(post: Pick<PostDto, 'classification'>): { label: string; score: number } | null {
  const cats = post.classification?.categories ?? [];
  let best: { label: string; score: number } | null = null;
  for (const c of cats) if (!best || c.score > best.score) best = c;
  return best;
}

/** What the model called a post, in the model's own label space: the 3-class label, else the top category. */
export function primaryLabel(
  post: Pick<PostDto, 'classification'>,
): { kind: 'category' | 'class'; id: string } | null {
  const c = post.classification;
  if (!c) return null;
  if (c.threeClass) return { kind: 'class', id: c.threeClass.label };
  const top = topCategory(post);
  return top ? { kind: 'category', id: top.label } : null;
}
