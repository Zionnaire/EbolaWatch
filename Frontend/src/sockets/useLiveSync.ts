import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { keys } from '@/api/queries';
import { useToast } from '@/components/feedback/Toast';
import { SocketEventSchemas, type PostDto, type SystemStatus } from '@/contracts';
import { pushNotify } from '@/utils/pushNotifications';
import { createSocket } from './socket';

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline';

// Connection state is a single tiny external store: it is not server data, and only the header reads it.
let liveState: LiveState = 'connecting';
const listeners = new Set<() => void>();
function setLive(next: LiveState) {
  if (liveState === next) return;
  liveState = next;
  listeners.forEach((l) => l());
}
export const useLiveState = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => liveState,
  );

/** The last few classified posts, newest first. Lives in the query cache so any component can read it. */
export const LIVE_FEED_KEY = ['live', 'feed'] as const;
const FEED_SIZE = 12;
const URGENT_TOAST_GAP_MS = 8000;

function patchPost(qc: QueryClient, post: PostDto) {
  // the detail view, if open, gets the new numbers immediately; lists are refetched (ordering and filters are the server's)
  qc.setQueryData(keys.post(post.id), (old: { post: PostDto } | undefined) => (old ? { ...old, post } : old));
  qc.setQueryData<PostDto[]>(LIVE_FEED_KEY, (feed = []) =>
    [post, ...feed.filter((p) => p.id !== post.id)].slice(0, FEED_SIZE),
  );
}

/** Opens the socket for the signed-in session and wires every event into the query cache and the toasts. */
export function useLiveSync(onOpenPost?: (id: string) => void) {
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    const socket = createSocket();
    let first = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastUrgentToast = 0;
    let skippedUrgent = 0;
    let summaryTimer: ReturnType<typeof setTimeout> | null = null;
    // a burst of classifications should cause one refetch, not fifty
    const refreshLists = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ queryKey: keys.posts() });
        void qc.invalidateQueries({ queryKey: ['analytics'] });
      }, 1200);
    };

    socket.on('connect', () => {
      setLive('live');
      // anything that happened while we were away is picked up by refetching what is on screen
      if (!first) void qc.invalidateQueries();
      first = false;
    });
    socket.on('disconnect', () => setLive('reconnecting'));
    socket.on('connect_error', (err) => {
      // a refused handshake means the session is gone; the REST layer notices and signs out on its next call
      setLive(socket.active ? 'reconnecting' : 'offline');
      if (err.message === 'unauthorized') void qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    });

    socket.on('model:status', (raw) => {
      const e = SocketEventSchemas['model:status'].safeParse(raw);
      if (!e.success) return;
      qc.setQueryData<SystemStatus>(keys.status, (old) => (old ? { ...old, ...e.data } : old));
    });

    socket.on('system:update', (raw) => {
      const e = SocketEventSchemas['system:update'].safeParse(raw);
      if (!e.success) return;
      qc.setQueryData(keys.status, e.data.status);
      void qc.invalidateQueries({ queryKey: keys.posts() });
    });

    socket.on('post:classified', (raw) => {
      const e = SocketEventSchemas['post:classified'].safeParse(raw);
      if (!e.success) return;
      patchPost(qc, e.data);
      refreshLists();
      if (e.data.decision?.urgent && e.data.reviewStatus === 'unreviewed') {
        const snippet = e.data.text.length > 110 ? `${e.data.text.slice(0, 110)}…` : e.data.text;
        const id = e.data.id;
        const open = onOpenPost ? { label: 'Open', onClick: () => onOpenPost(id) } : undefined;
        // a burst of urgent posts becomes one toast now and one summary later, not a wall of toasts
        if (Date.now() - lastUrgentToast >= URGENT_TOAST_GAP_MS) {
          lastUrgentToast = Date.now();
          toast.show({
            kind: 'warning',
            title: 'Urgent post needs review',
            body: snippet,
            duration: 12_000,
            action: open,
          });
        } else {
          skippedUrgent++;
          summaryTimer ??= setTimeout(() => {
            summaryTimer = null;
            lastUrgentToast = Date.now();
            toast.show({
              kind: 'warning',
              title: `${skippedUrgent} more urgent ${skippedUrgent === 1 ? 'post needs' : 'posts need'} review`,
              body: 'Open the review queue to see them, most pressing first.',
              duration: 12_000,
              action: open,
            });
            skippedUrgent = 0;
          }, URGENT_TOAST_GAP_MS);
        }
        pushNotify({
          title: 'Urgent post needs review',
          body: snippet,
          tag: `post-${e.data.id}`,
          onClick: () => onOpenPost?.(e.data.id),
        });
      }
    });

    socket.on('alert', (raw) => {
      const e = SocketEventSchemas.alert.safeParse(raw);
      if (!e.success) return;
      const { level, message } = e.data;
      if (level === 'critical') toast.error('Critical alert', message);
      else if (level === 'warning') toast.warning('Warning', message);
      else toast.info('Notice', message);
      if (level !== 'info')
        pushNotify({
          title: level === 'critical' ? 'Critical alert' : 'Warning',
          body: message,
          tag: `alert-${e.data.code}`,
        });
    });

    setLive('connecting');
    socket.connect();
    return () => {
      if (timer) clearTimeout(timer);
      if (summaryTimer) clearTimeout(summaryTimer);
      socket.removeAllListeners();
      socket.disconnect();
      setLive('connecting');
    };
    // the handlers read toast/onOpenPost through refs of the first render on purpose: reconnecting the socket
    // because a callback identity changed would drop live events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);
}
