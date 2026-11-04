import { describe, expect, it } from 'vitest';
import { percent, plural, prettify, secondsUntil, timeAgo } from './format';

describe('format', () => {
  it('prettifies raw ids', () => {
    expect(prettify('fake_cure_prevention')).toBe('Fake cure prevention');
    expect(prettify('')).toBe('');
  });
  it('relative time', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(timeAgo('2026-10-27T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-10-27T11:30:00Z', now)).toBe('30 min ago');
    expect(timeAgo('2026-10-27T07:00:00Z', now)).toBe('5 h ago');
    expect(timeAgo('2026-10-25T12:00:00Z', now)).toBe('2 d ago');
  });
  it('countdown never goes negative and tolerates null', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(secondsUntil('2026-10-27T12:00:09Z', now)).toBe(9);
    expect(secondsUntil('2026-10-27T11:00:00Z', now)).toBe(0);
    expect(secondsUntil(null, now)).toBeNull();
  });
  it('percent and plural', () => {
    expect(percent(0.456)).toBe('46%');
    expect(percent(null)).toBe('—');
    expect(plural(1, 'post')).toBe('1 post');
    expect(plural(2, 'post')).toBe('2 posts');
  });
});
