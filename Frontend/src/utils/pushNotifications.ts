/**
 * Browser notifications for things an analyst must not miss while the tab is in the background (a critical alert,
 * an urgent post). This is the Notification API, which works while the app is open somewhere; true background push
 * (app closed) needs a service worker and server-side Web Push keys, which the backend does not have yet.
 * The in-app toast is always shown; the system notification is an addition, and only with the user's consent.
 */
const PREF_KEY = 'ew.push';

export type PushState = 'unsupported' | 'denied' | 'default' | 'on' | 'off';

export const pushSupported = () => typeof window !== 'undefined' && 'Notification' in window;

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}
function writePref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* private mode: the choice just will not persist */
  }
}

export function pushState(): PushState {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'default';
  return readPref() ? 'on' : 'off';
}

/** Must be called from a click: browsers only show the permission prompt for a user gesture. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const result = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (result === 'granted') writePref(true);
  return pushState();
}

export function disablePush(): PushState {
  writePref(false);
  return pushState();
}

export interface PushMessage {
  title: string;
  body?: string;
  /** Same tag replaces the previous notification instead of stacking. */
  tag?: string;
  onClick?: () => void;
}

/** Shows a system notification when the user opted in and the tab is not the one in front. */
export function pushNotify(m: PushMessage): boolean {
  if (pushState() !== 'on') return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus())
    return false;
  try {
    const n = new Notification(m.title, { body: m.body, tag: m.tag, icon: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      m.onClick?.();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
