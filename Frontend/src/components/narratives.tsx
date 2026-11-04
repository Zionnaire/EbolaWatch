import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useGenerateNarrative, useNarrativeConfig, useNarratives } from '@/api/queries';
import { Can } from '@/auth/AuthProvider';
import { useToast } from '@/components/feedback/Toast';
import { Chip, Dialog, EmptyState, Field, SkeletonRows, SubmitButton, errorMessage } from '@/components/ui';
import { NARRATIVE } from '@/config/status';
import type { GenerateNarrativeRequest, NarrativeStatus, PostDto } from '@/contracts';
import { useNames } from '@/hooks/useNames';
import { Icon } from '@/icons';
import { timeAgo } from '@/utils/format';
import { topCategory } from '@/utils/post';

export function NarrativeStatusChip({ status }: { status: NarrativeStatus }) {
  const s = NARRATIVE[status];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

/** Draft a counter-narrative for a post, or (without one) for a claim typed in by hand. */
export function GenerateDialog({ post, onClose }: { post?: PostDto; onClose: () => void }) {
  const config = useNarrativeConfig();
  const names = useNames(post?.classification?.taxonomyVersion);
  const generate = useGenerateNarrative();
  const toast = useToast();
  const navigate = useNavigate();

  const [claim, setClaim] = useState('');
  const [platform, setPlatform] = useState('');
  const [language, setLanguage] = useState('');
  const [category, setCategory] = useState(post ? (topCategory(post)?.label ?? '') : '');
  const [guidance, setGuidance] = useState('');

  const platforms = config.data?.platforms ?? [];
  const chosenPlatform =
    platform || (post && platforms.find((p) => p.id === post.platform)?.id) || platforms[0]?.id || '';
  const manual = !post;
  const ready = !!chosenPlatform && (!manual || claim.trim().length > 0);

  const submit = () => {
    const body: GenerateNarrativeRequest = {
      ...(post ? { postId: post.id } : { claim: claim.trim() }),
      platform: chosenPlatform,
      ...(language ? { language: language as GenerateNarrativeRequest['language'] } : {}),
      ...(category ? { category } : {}),
      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
    };
    generate.mutate(body, {
      onSuccess: (d) => {
        toast.success('Draft ready', 'Read it, edit it if needed, then send it for approval.');
        onClose();
        navigate(`/narratives/${d.narrative.id}`);
      },
      onError: (e) => toast.error('Could not write a draft', errorMessage(e)),
    });
  };

  return (
    <Dialog
      title={manual ? 'Write a counter-narrative' : 'Draft a response to this post'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton pending={generate.isPending} disabled={!ready} onClick={submit}>
            <Icon name="spark" size={16} /> Write draft
          </SubmitButton>
        </>
      }
    >
      {config.data?.generator.mode === 'mock' && (
        <p className="callout callout--warn" style={{ margin: 0 }}>
          <Icon name="flask" size={18} />
          <span>The writer is in mock mode: drafts are templates, not real model output.</span>
        </p>
      )}
      {config.data?.generator.mode === 'live' && (
        <p className="callout" style={{ margin: 0 }}>
          <Icon name="spark" size={18} />
          <span>
            An AI writer drafts the reply using only the verified NCDC and WHO fact base, and cites it. If the
            fact base has nothing on the claim, it will say so and write nothing. You still read, edit and
            approve before anything is sent.
          </span>
        </p>
      )}
      {manual && (
        <Field
          label="The claim to answer"
          hint="Paste or describe the false claim. Do not include names or contact details."
        >
          {(id, by) => (
            <textarea
              id={id}
              aria-describedby={by}
              className="textarea"
              maxLength={2000}
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
            />
          )}
        </Field>
      )}
      <div className="grid grid--2" style={{ gap: 12 }}>
        <Field
          label="Where it will be posted"
          hint={
            config.data?.platforms.find((p) => p.id === chosenPlatform)
              ? `Limit ${platforms.find((p) => p.id === chosenPlatform)?.charLimit} characters`
              : undefined
          }
        >
          {(id) => (
            <select
              id={id}
              className="select"
              value={chosenPlatform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Language">
          {(id) => (
            <select id={id} className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">Same as the post</option>
              {config.data?.languages.map((l) => (
                <option key={l} value={l}>
                  {names.language(l)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="Topic">
        {(id) => (
          <select id={id} className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Let the writer decide</option>
            {names.taxonomy?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Guidance (optional)" hint="For example: keep it calm, mention the hotline.">
        {(id, by) => (
          <input
            id={id}
            aria-describedby={by}
            className="input"
            maxLength={500}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

/** The counter-narratives written for one post, with a way to start another. */
export function PostNarratives({ post }: { post: PostDto }) {
  const q = useNarratives({ postId: post.id, pageSize: 20 });
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      {q.isPending ? (
        <SkeletonRows rows={2} h={48} />
      ) : q.data && q.data.items.length > 0 ? (
        <ul className="stack stack--sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {q.data.items.map((n) => (
            <li key={n.id}>
              <Link
                to={`/narratives/${n.id}`}
                className="card"
                style={{ display: 'block', padding: '12px 14px', textDecoration: 'none', color: 'inherit' }}
              >
                <div className="row row--between" style={{ marginBottom: 4 }}>
                  <NarrativeStatusChip status={n.status} />
                  <span className="faint small">{timeAgo(n.updatedAt)}</span>
                </div>
                <p className="post-text small">{n.text}</p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState scene="sprout" title="No response drafted yet">
          A clear, sourced reply can be drafted in a few seconds.
        </EmptyState>
      )}
      <Can permission="narratives:draft">
        <button className="btn" onClick={() => setOpen(true)} style={{ alignSelf: 'flex-start' }}>
          <Icon name="spark" size={16} /> Draft a response
        </button>
      </Can>
      {open && <GenerateDialog post={post} onClose={() => setOpen(false)} />}
    </div>
  );
}
