import { describe, it, expect } from 'vitest';
import { splitMessage } from '../../src/core/message-formatter.js';

describe('splitMessage', () => {
  it('returns a single chunk when text fits within limit', () => {
    expect(splitMessage('hello world', 100)).toEqual(['hello world']);
  });

  it('splits at paragraph boundary when available', () => {
    const text = 'first paragraph\n\nsecond paragraph';
    const [a, b] = splitMessage(text, 20);
    expect(a).toBe('first paragraph');
    expect(b).toBe('second paragraph');
  });

  it('splits at line boundary when no paragraph break fits', () => {
    const text = 'line one\nline two';
    const [a, b] = splitMessage(text, 12);
    expect(a).toBe('line one');
    expect(b).toBe('line two');
  });

  it('hard-cuts when no line break fits', () => {
    const text = 'abcdefghij';
    const [a, b] = splitMessage(text, 5);
    expect(a).toBe('abcde');
    expect(b).toBe('fghij');
  });

  it('produces multiple chunks for long text', () => {
    const para = 'word '.repeat(20).trim(); // 99 chars
    const text = [para, para, para].join('\n\n');
    const chunks = splitMessage(text, 110);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(110);
    }
  });

  it('trims whitespace from chunk boundaries', () => {
    const text = 'aaa\n\n   bbb';
    const [a, b] = splitMessage(text, 6);
    expect(a).toBe('aaa');
    expect(b).toBe('bbb');
  });
});
