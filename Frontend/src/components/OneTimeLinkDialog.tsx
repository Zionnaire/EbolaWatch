import { useState } from 'react';
import { Callout, Dialog } from '@/components/ui';
import { formatDateTime } from '@/utils/format';
import { Icon } from '@/icons';

/** Shows a one-time link once. The server keeps only a hash, so closing this dialog loses it for good. */
export function OneTimeLinkDialog({
  title,
  intro,
  link,
  onClose,
}: {
  title: string;
  intro: string;
  link: { url: string; expiresAt: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted">{intro}</p>
      <p className="code-box">{link.url}</p>
      <div className="row">
        <button className="btn btn--ghost btn--sm" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copied' : 'Copy link'}
        </button>
        <span className="small muted">Works once. Expires {formatDateTime(link.expiresAt)}.</span>
      </div>
      <Callout tone="warn" icon="warning">
        This is the only time the link is shown. If it is lost, make a new one.
      </Callout>
    </Dialog>
  );
}
