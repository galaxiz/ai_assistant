import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionStore } from './store.js';
import type { Session } from './types.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  describe('create', () => {
    it('returns a session with a unique UUID', () => {
      const a = store.create();
      const b = store.create();
      expect(a.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(a.sessionId).not.toBe(b.sessionId);
    });

    it('initialises state to idle with empty history', () => {
      const s = store.create();
      expect(s.state).toBe('idle');
      expect(s.conversationHistory).toEqual([]);
    });

    it('sets createdAt and lastActive to current time', () => {
      const before = Date.now();
      const s = store.create();
      const after = Date.now();
      expect(s.createdAt).toBeGreaterThanOrEqual(before);
      expect(s.createdAt).toBeLessThanOrEqual(after);
      expect(s.lastActive).toBe(s.createdAt);
    });
  });

  describe('get', () => {
    it('returns the session by id', () => {
      const s = store.create();
      expect(store.get(s.sessionId)).toBe(s);
    });

    it('returns undefined for unknown id', () => {
      expect(store.get('no-such-id')).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('removes an existing session and returns true', () => {
      const s = store.create();
      expect(store.remove(s.sessionId)).toBe(true);
      expect(store.get(s.sessionId)).toBeUndefined();
    });

    it('returns false for an unknown id', () => {
      expect(store.remove('no-such-id')).toBe(false);
    });

    it('releases the lock so withSession throws after removal', async () => {
      const s = store.create();
      store.remove(s.sessionId);
      await expect(store.withSession(s.sessionId, async () => {})).rejects.toThrow(
        'Session not found',
      );
    });
  });

  describe('listActive', () => {
    it('returns all sessions', () => {
      const a = store.create();
      const b = store.create();
      const list = store.listActive();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.sessionId)).toEqual(
        expect.arrayContaining([a.sessionId, b.sessionId]),
      );
    });

    it('returns empty array when store is empty', () => {
      expect(store.listActive()).toEqual([]);
    });
  });

  describe('cleanupExpired', () => {
    it('removes sessions whose lastActive exceeds the TTL', () => {
      const shortTtl = new SessionStore(100); // 100 ms TTL
      const s = shortTtl.create();

      vi.useFakeTimers();
      vi.advanceTimersByTime(200);
      const removed = shortTtl.cleanupExpired();
      vi.useRealTimers();

      expect(removed).toBe(1);
      expect(shortTtl.get(s.sessionId)).toBeUndefined();
    });

    it('keeps sessions that are still within TTL', () => {
      const shortTtl = new SessionStore(10_000);
      shortTtl.create();

      const removed = shortTtl.cleanupExpired();
      expect(removed).toBe(0);
      expect(shortTtl.listActive()).toHaveLength(1);
    });

    it('returns 0 when store is empty', () => {
      expect(store.cleanupExpired()).toBe(0);
    });
  });

  describe('withSession', () => {
    it('provides mutable access to the session', async () => {
      const s = store.create();
      await store.withSession(s.sessionId, async (session) => {
        session.state = 'processing';
        session.conversationHistory.push({ role: 'user', content: 'hello' });
      });
      const updated = store.get(s.sessionId)!;
      expect(updated.state).toBe('processing');
      expect(updated.conversationHistory).toHaveLength(1);
    });

    it('updates lastActive on each call', async () => {
      vi.useFakeTimers();
      const s = store.create();
      const original = s.lastActive;

      vi.advanceTimersByTime(500);
      await store.withSession(s.sessionId, async () => {});
      vi.useRealTimers();

      expect(store.get(s.sessionId)!.lastActive).toBeGreaterThan(original);
    });

    it('serialises concurrent calls on the same session', async () => {
      const s = store.create();
      const order: number[] = [];

      const first = store.withSession(s.sessionId, async (session) => {
        await new Promise<void>((r) => setTimeout(r, 20));
        order.push(1);
        session.state = 'processing';
      });

      const second = store.withSession(s.sessionId, async (session) => {
        order.push(2);
        session.state = 'idle';
      });

      await Promise.all([first, second]);
      expect(order).toEqual([1, 2]);
    });

    it('allows concurrent calls on different sessions', async () => {
      const a = store.create();
      const b = store.create();
      const order: string[] = [];

      const p1 = store.withSession(a.sessionId, async () => {
        await new Promise<void>((r) => setTimeout(r, 20));
        order.push('a');
      });
      const p2 = store.withSession(b.sessionId, async () => {
        order.push('b');
      });

      await Promise.all([p1, p2]);
      // b finishes before a because it doesn't wait
      expect(order).toEqual(['b', 'a']);
    });

    it('throws for unknown session id', async () => {
      await expect(store.withSession('ghost', async () => {})).rejects.toThrow(
        'Session not found: ghost',
      );
    });

    it('propagates errors from the callback', async () => {
      const s = store.create();
      await expect(
        store.withSession(s.sessionId, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('releases the lock after an error so the session remains usable', async () => {
      const s = store.create();
      await store.withSession(s.sessionId, async () => {
        throw new Error('transient');
      }).catch(() => {});

      // Should not hang — lock must have been released
      const result = await store.withSession(s.sessionId, async (session) => session.sessionId);
      expect(result).toBe(s.sessionId);
    });
  });
});
