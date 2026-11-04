import { useState } from 'react';
import { useReviewPost } from '@/api/queries';
import { useToast } from '@/components/feedback/Toast';
import { Field, SubmitButton, errorMessage } from '@/components/ui';
import {
  ThreeClassLabelSchema,
  type Classification,
  type ReviewDecisionSchema,
  type Stance,
} from '@/contracts';
import type { Names } from '@/hooks/useNames';
import { prettify } from '@/utils/format';
import type { z } from 'zod';

type Decision = z.infer<typeof ReviewDecisionSchema>;

const CHOICES: Array<{ id: Decision; title: string; text: string }> = [
  { id: 'confirmed', title: 'The model is right', text: 'This is misinformation, labelled correctly.' },
  { id: 'rejected', title: 'The model is wrong', text: 'This is not misinformation.' },
  {
    id: 'corrected',
    title: 'Right post, wrong label',
    text: 'It is misinformation, but of a different kind.',
  },
];

/** The analyst's verdict on one classification: confirm, reject, or correct the labels. */
export function ReviewForm({
  postId,
  classification,
  names,
}: {
  postId: string;
  classification: Classification;
  names: Names;
}) {
  const review = useReviewPost(postId);
  const toast = useToast();
  const threeClass = classification.contract === 'threeclass-v0';
  const [decision, setDecision] = useState<Decision>('confirmed');
  const [labels, setLabels] = useState<string[]>([]);
  const [stance, setStance] = useState<Stance | ''>('');
  const [note, setNote] = useState('');

  const needsLabels = decision === 'corrected';
  const invalid = needsLabels && labels.length === 0;

  const toggle = (id: string) => setLabels((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        review.mutate(
          {
            decision,
            note: note.trim() || undefined,
            ...(needsLabels ? { correction: { labels, ...(stance ? { stance } : {}) } } : {}),
          },
          {
            onSuccess: () =>
              toast.success(
                'Review saved',
                'Thank you. Your decision is recorded and will help check the model.',
              ),
            onError: (err) => toast.error('Could not save the review', errorMessage(err)),
          },
        );
      }}
    >
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack stack--sm">
        <legend className="field__label" style={{ marginBottom: 6 }}>
          Your verdict
        </legend>
        {CHOICES.map((c) => (
          <label
            key={c.id}
            className="check"
            style={{
              alignItems: 'flex-start',
              padding: '8px 10px',
              borderRadius: 12,
              border: '1.5px solid',
              borderColor: decision === c.id ? 'var(--forest-500)' : 'var(--card-edge)',
              background: decision === c.id ? 'var(--forest-100)' : 'transparent',
            }}
          >
            <input
              type="radio"
              name="decision"
              value={c.id}
              checked={decision === c.id}
              onChange={() => setDecision(c.id)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>{c.title}</strong>
              <br />
              <span className="muted small">{c.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {needsLabels && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack stack--sm">
          <legend className="field__label" style={{ marginBottom: 6 }}>
            {threeClass ? 'What is it?' : 'What is it really about? (choose one or more)'}
          </legend>
          {threeClass
            ? ThreeClassLabelSchema.options.map((l) => (
                <label key={l} className="check">
                  <input
                    type="radio"
                    name="label"
                    checked={labels[0] === l}
                    onChange={() => setLabels([l])}
                  />
                  {prettify(l)}
                </label>
              ))
            : names.taxonomy?.categories.map((c) => (
                <label key={c.id} className="check" title={c.description}>
                  <input type="checkbox" checked={labels.includes(c.id)} onChange={() => toggle(c.id)} />
                  {c.displayName}
                </label>
              ))}
          {!threeClass && (
            <Field label="Stance of the post (optional)">
              {(id) => (
                <select
                  id={id}
                  className="select"
                  value={stance}
                  onChange={(e) => setStance(e.target.value as Stance | '')}
                >
                  <option value="">Leave as the model said</option>
                  {names.taxonomy?.stances.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          {invalid && <p className="field__error">Choose at least one.</p>}
        </fieldset>
      )}

      <Field label="Note (optional)" hint="Visible to your team. Do not include personal details.">
        {(id, by) => (
          <textarea
            id={id}
            aria-describedby={by}
            className="textarea"
            style={{ minHeight: 80 }}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <SubmitButton type="submit" pending={review.isPending} disabled={invalid}>
        Save review
      </SubmitButton>
    </form>
  );
}
