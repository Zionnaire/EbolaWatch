import { describe, expect, it } from 'vitest';
import { hashAuthor, safeEqual, textHash } from '../src/utils/hashing.js';
import { scrubPii } from '../src/utils/pii.js';

describe('scrubPii: handles and mentions', () => {
  it.each([
    ['thanks @NCDCgov for the update', 'thanks [handle] for the update'],
    ['RT @some_user: stay safe', 'RT [handle]: stay safe'],
    ['@a @b @c all of you', '[handle] [handle] [handle] all of you'],
    ['follow @user.bsky.social now', 'follow [handle] now'],
    ['(@aisha_lagos)', '([handle])'],
  ])('%s', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });
});

describe('scrubPii: URLs', () => {
  it.each([
    ['see https://example.com/ebola?id=1 today', 'see [url] today'],
    ['see http://example.ng/a/b.', 'see [url].'],
    ['see www.health.gov.ng/news for more', 'see [url] for more'],
    ['scheme-less example.com/cure works', 'scheme-less [url] works'],
    ['link: bit.ly/3abcXYZ!', 'link: [url]!'],
    ['t.co/abc123 is fake', '[url] is fake'],
    ['visit ncdc.gov.ng', 'visit [url]'],
    ['host:8080 style health.example.org:8080/path', 'host:8080 style [url]'],
  ])('%s', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });

  it('does not eat ordinary text that merely contains dots', () => {
    const s = 'e.g. Ebola.It was reported. Cases rose 2.5 times in Lagos.';
    expect(scrubPii(s)).toBe(s);
  });
});

describe('scrubPii: emails', () => {
  it('replaces emails before handle matching can mangle them', () => {
    expect(scrubPii('mail me: john.doe+ebola@mail.example.com ok')).toBe('mail me: [email] ok');
    expect(scrubPii('a@b.co and c@d.org')).toBe('[email] and [email]');
  });
});

describe('scrubPii: phone numbers', () => {
  it.each([
    ['call 08031234567 now', 'call [phone] now'],
    ['call 0803 123 4567 now', 'call [phone] now'],
    ['call 0803-123-4567 now', 'call [phone] now'],
    ['call 0803.123.4567 now', 'call [phone] now'],
    ['call 080 3123 4567 now', 'call [phone] now'],
    ['call +2348031234567 now', 'call [phone] now'],
    ['call +234 803 123 4567 now', 'call [phone] now'],
    ['call +234-803-123-4567 now', 'call [phone] now'],
    ['call 2348031234567 now', 'call [phone] now'],
    ['call +234 (0) 803 123 4567 now', 'call [phone] now'],
    ['mtn 07012345678, glo 08051234567, airtel 09021234567', 'mtn [phone], glo [phone], airtel [phone]'],
    ['intl +44 20 7946 0958 office', 'intl [phone] office'],
    ['intl +1 (415) 555 0132 office', 'intl [phone] office'],
  ])('%s', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });

  it('leaves dates, counts and ids alone', () => {
    const s = 'On 2014-08-31 at 12:00 there were 894 contacts and 18500 visits; ref 2014/08/31.';
    expect(scrubPii(s)).toBe(s);
    expect(scrubPii('1,200,000 people')).toBe('1,200,000 people');
  });
});

describe('scrubPii: combined and edge cases', () => {
  it('scrubs a realistic post with several kinds of PII', () => {
    const raw =
      '@ayo_k says drink salt water!! call 0803 000 0000 or mail ayo@mail.com, see bit.ly/abc and https://x.example/p';
    expect(scrubPii(raw)).toBe(
      '[handle] says drink salt water!! call [phone] or mail [email], see [url] and [url]',
    );
  });

  it('is idempotent and handles empty input', () => {
    const once = scrubPii('hello @x 08031234567 a.com');
    expect(scrubPii(once)).toBe(once);
    expect(scrubPii('')).toBe('');
  });

  it('keeps Pidgin / Hausa / Yoruba text intact', () => {
    const s = 'Ebola no dey o, abeg make una no drink salt water. Ka sha ruwa mai tsabta.';
    expect(scrubPii(s)).toBe(s);
  });
});

describe('hashing', () => {
  it('author hash is an HMAC: deterministic, secret-dependent, normalised, not a bare SHA-256', () => {
    const a = hashAuthor('secret-secret-secret-1', 'bluesky', '@Ayo.K');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAuthor('secret-secret-secret-1', 'bluesky', 'ayo.k')).toBe(a);
    expect(hashAuthor('secret-secret-secret-2', 'bluesky', 'ayo.k')).not.toBe(a);
    expect(hashAuthor('secret-secret-secret-1', 'youtube', 'ayo.k')).not.toBe(a);
    expect(a).not.toBe(textHash('bluesky:ayo.k'));
  });

  it('safeEqual compares equal strings, and handles different lengths without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
