import { useState, useSyncExternalStore } from 'react';
import { useSetMode, useSystemStatus } from '@/api/queries';
import { useCan } from '@/auth/AuthProvider';
import { useToast } from '@/components/feedback/Toast';
import { Chip, Dialog, SubmitButton, errorMessage } from '@/components/ui';
import { MODEL_STATUS, OPERATING_MODE, STAGE_LABEL } from '@/config/status';
import { mockStages, type OperatingMode } from '@/contracts';
import { useCountdown } from '@/hooks/useCountdown';
import { Icon } from '@/icons';
import { useLiveState } from '@/sockets/useLiveSync';
import { disablePush, enablePush, pushState, pushSupported, type PushState } from '@/utils/pushNotifications';

/** Persistent header strip: operating mode, model status (with the warm-up countdown), live connection, alerts. */
export function StatusBar() {
  const status = useSystemStatus();
  const live = useLiveState();
  const s = status.data;
  const seconds = useCountdown(s?.modelStatus === 'warming' ? s.retryAvailableAt : null);

  return (
    <>
      <div className="row" aria-label="System status" role="group" style={{ gap: 8 }}>
        {s ? (
          <>
            <ModeChip mode={s.operatingMode} />
            <Chip
              tone={MODEL_STATUS[s.modelStatus].tone}
              title={s.modelVersion ? `Model version ${s.modelVersion}` : undefined}
            >
              <span className={`dot ${s.modelStatus === 'warming' ? 'dot--pulse' : ''}`} />
              {MODEL_STATUS[s.modelStatus].label}
              {s.modelStatus === 'warming' && seconds !== null && seconds > 0 && ` · about ${seconds}s`}
            </Chip>
          </>
        ) : (
          <Chip tone="idle">{status.isError ? 'Status unavailable' : 'Checking status…'}</Chip>
        )}
      </div>
      <div className="topbar__spacer" />
      <Chip
        tone={live === 'live' ? 'ok' : live === 'offline' ? 'bad' : 'wait'}
        icon="signal"
        title="Live connection to the server"
      >
        {live === 'live'
          ? 'Live'
          : live === 'connecting'
            ? 'Connecting'
            : live === 'reconnecting'
              ? 'Reconnecting'
              : 'Offline'}
      </Chip>
      <AlertsButton />
    </>
  );
}

function ModeChip({ mode }: { mode: OperatingMode }) {
  const canOperate = useCan('platform:operate');
  const [open, setOpen] = useState(false);
  const label = OPERATING_MODE[mode].label;
  if (!canOperate) {
    return (
      <Chip tone={mode === 'surge' ? 'warn' : 'idle'} title={OPERATING_MODE[mode].hint}>
        {label} mode
      </Chip>
    );
  }
  return (
    <>
      <button
        className={`chip ${mode === 'surge' ? 'chip--warn' : ''}`}
        onClick={() => setOpen(true)}
        title="Change operating mode"
        style={{ border: 0 }}
      >
        {label} mode <Icon name="chevronDown" size={14} />
      </button>
      {open && <ModeDialog current={mode} onClose={() => setOpen(false)} />}
    </>
  );
}

function ModeDialog({ current, onClose }: { current: OperatingMode; onClose: () => void }) {
  const set = useSetMode();
  const toast = useToast();
  const [mode, setMode] = useState<OperatingMode>(current);
  return (
    <Dialog
      title="Operating mode"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton
            pending={set.isPending}
            disabled={mode === current}
            onClick={() =>
              set.mutate(mode, {
                onSuccess: () => {
                  toast.success(
                    `Switched to ${OPERATING_MODE[mode].label} mode`,
                    'Open posts are being re-evaluated.',
                  );
                  onClose();
                },
                onError: (e) => toast.error('Could not change the mode', errorMessage(e)),
              })
            }
          >
            Apply
          </SubmitButton>
        </>
      }
    >
      <p className="muted">This changes how strictly posts are flagged for every organization.</p>
      {(Object.keys(OPERATING_MODE) as OperatingMode[]).map((m) => (
        <label key={m} className="check" style={{ alignItems: 'flex-start' }}>
          <input
            type="radio"
            name="mode"
            checked={mode === m}
            onChange={() => setMode(m)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>{OPERATING_MODE[m].label}</strong>
            <br />
            <span className="muted small">{OPERATING_MODE[m].hint}</span>
          </span>
        </label>
      ))}
    </Dialog>
  );
}

// The notification preference lives in the browser, outside React; subscribe so the bell reflects it.
const subs = new Set<() => void>();
const pushSnapshot = () => pushState();
const subscribePush = (l: () => void) => {
  subs.add(l);
  return () => subs.delete(l);
};
const bump = () => subs.forEach((l) => l());

function AlertsButton() {
  const state = useSyncExternalStore(subscribePush, pushSnapshot, () => 'unsupported' as PushState);
  const toast = useToast();
  if (!pushSupported()) return null;

  const titles: Record<PushState, string> = {
    unsupported: '',
    denied: 'Desktop alerts are blocked in your browser settings',
    default: 'Turn on desktop alerts for urgent posts',
    on: 'Desktop alerts are on. Click to turn off',
    off: 'Desktop alerts are off. Click to turn on',
  };

  const click = async () => {
    if (state === 'denied') {
      toast.warning(
        'Alerts are blocked',
        'Allow notifications for this site in your browser settings, then try again.',
      );
      return;
    }
    if (state === 'on') {
      disablePush();
      toast.info('Desktop alerts off');
    } else {
      const next = await enablePush();
      if (next === 'on')
        toast.success(
          'Desktop alerts on',
          'You will be notified about urgent posts and critical alerts when this tab is in the background.',
        );
      else toast.warning('Alerts were not enabled', 'The browser did not grant permission.');
    }
    bump();
  };

  return (
    <button
      className="btn btn--quiet btn--icon"
      onClick={() => void click()}
      title={titles[state]}
      aria-label={titles[state]}
      aria-pressed={state === 'on'}
    >
      <Icon name={state === 'on' ? 'bell' : 'bellOff'} size={20} />
    </button>
  );
}

/** The MOCK DATA banner: shown whenever any pipeline stage is not live, naming which. */
export function MockBanner() {
  const { data } = useSystemStatus();
  if (!data) return null;
  const stages = mockStages(data.dataSource);
  if (stages.length === 0) return null;
  return (
    <div className="banner" role="status">
      <Chip tone="mock" icon="flask">
        Mock data
      </Chip>
      <span>
        Not live:{' '}
        <strong style={{ textTransform: 'none', letterSpacing: 0 }}>
          {stages.map((s) => STAGE_LABEL[s] ?? s).join(', ')}
        </strong>
        . What you see here is not real social media activity.
      </span>
    </div>
  );
}
