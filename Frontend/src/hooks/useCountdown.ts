import { useEffect, useState } from 'react';
import { secondsUntil } from '@/utils/format';

/** Whole seconds left until an absolute ISO time, re-rendering once a second; null when there is no target. */
export function useCountdown(until: string | null | undefined): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  // computed from the clock on every render, so it is right immediately when the target changes
  return until ? secondsUntil(until) : null;
}
