import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { SessionMap } from '../../src/core/session-map.js';
import type { SessionKey } from '../../src/core/session-map.js';

const logger = pino({ level: 'silent' });

const key1: SessionKey = { platform: 'telegram', platformUserId: 'u1', channelId: 'c1' };
const key2: SessionKey = { platform: 'slack', platformUserId: 'u1', channelId: 'c1' };
const key3: SessionKey = { platform: 'telegram', platformUserId: 'u2', channelId: 'c1' };

describe('SessionMap', () => {
  let map: SessionMap;

  beforeEach(() => {
    map = new SessionMap({ idleTtlMs: 60_000 }, logger);
  });

  afterEach(() => {
    map.destroy();
    vi.useRealTimers();
  });

  it('returns undefined for an unknown key', () => {
    expect(map.get(key1)).toBeUndefined();
  });

  it('stores and retrieves a session id', () => {
    map.set(key1, 'session-abc');
    expect(map.get(key1)).toBe('session-abc');
  });

  it('different platforms with same user/channel are independent keys', () => {
    map.set(key1, 'tg-session');
    map.set(key2, 'slack-session');
    expect(map.get(key1)).toBe('tg-session');
    expect(map.get(key2)).toBe('slack-session');
  });

  it('different users with same channel are independent keys', () => {
    map.set(key1, 'session-u1');
    map.set(key3, 'session-u2');
    expect(map.get(key1)).toBe('session-u1');
    expect(map.get(key3)).toBe('session-u2');
  });

  it('delete removes the entry', () => {
    map.set(key1, 'session-abc');
    map.delete(key1);
    expect(map.get(key1)).toBeUndefined();
  });

  it('updates size correctly', () => {
    expect(map.size).toBe(0);
    map.set(key1, 's1');
    map.set(key2, 's2');
    expect(map.size).toBe(2);
    map.delete(key1);
    expect(map.size).toBe(1);
  });

  it('evicts expired entries on get()', () => {
    vi.useFakeTimers();
    map.destroy(); // destroy the real-timer map
    map = new SessionMap({ idleTtlMs: 1_000 }, logger);
    map.set(key1, 'session-abc');
    vi.advanceTimersByTime(1_001);
    expect(map.get(key1)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('refreshes TTL on get()', () => {
    vi.useFakeTimers();
    map.destroy();
    map = new SessionMap({ idleTtlMs: 1_000 }, logger);
    map.set(key1, 'session-abc');
    vi.advanceTimersByTime(800);
    expect(map.get(key1)).toBe('session-abc'); // access resets clock
    vi.advanceTimersByTime(800); // 800ms from last access, not 1600ms from set
    expect(map.get(key1)).toBe('session-abc');
  });

  it('sweep timer evicts expired entries', () => {
    vi.useFakeTimers();
    map.destroy();
    map = new SessionMap({ idleTtlMs: 1_000, sweepIntervalMs: 500 }, logger);
    map.set(key1, 'session-abc');
    vi.advanceTimersByTime(1_600); // past TTL and sweep interval
    expect(map.size).toBe(0);
  });
});

describe('SessionMap.deleteByKeyPrefix', () => {
  let map: SessionMap;

  beforeEach(() => { map = new SessionMap({ idleTtlMs: 60_000 }, logger); });
  afterEach(() => { map.destroy(); });

  it('deletes an exact-match key', () => {
    map.set({ platform: 'slack', platformUserId: 'T1', channelId: 'C1' }, 's1');
    const deleted = map.deleteByKeyPrefix('slack:T1:C1');
    expect(deleted).toBe(1);
    expect(map.size).toBe(0);
  });

  it('deletes all thread sessions derived from a channel', () => {
    // DM key
    map.set({ platform: 'slack', platformUserId: 'T1', channelId: 'C1' }, 'dm-sess');
    // Thread keys
    map.set({ platform: 'slack', platformUserId: 'T1', channelId: 'C1:ts1' }, 'thread-1');
    map.set({ platform: 'slack', platformUserId: 'T1', channelId: 'C1:ts2' }, 'thread-2');
    // Different channel — must not be deleted
    map.set({ platform: 'slack', platformUserId: 'T1', channelId: 'C2' }, 'other');

    const deleted = map.deleteByKeyPrefix('slack:T1:C1');
    expect(deleted).toBe(3);
    expect(map.size).toBe(1);
    expect(map.get({ platform: 'slack', platformUserId: 'T1', channelId: 'C2' })).toBe('other');
  });

  it('returns 0 when no entries match', () => {
    map.set({ platform: 'slack', platformUserId: 'T1', channelId: 'C1' }, 's1');
    expect(map.deleteByKeyPrefix('slack:T1:C2')).toBe(0);
    expect(map.size).toBe(1);
  });

  it('does not delete entries that share a prefix substring but differ after a colon boundary', () => {
    // 'slack:T1:C1' should NOT match 'slack:T1:C10'
    map.set({ platform: 'slack', platformUserId: 'T1', channelId: 'C10' }, 's1');
    expect(map.deleteByKeyPrefix('slack:T1:C1')).toBe(0);
  });
});
