import { Mutex } from 'async-mutex';
import { v4 as uuidv4 } from 'uuid';
import type { Session } from './types.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly locks = new Map<string, Mutex>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  create(): Session {
    const session: Session = {
      sessionId: uuidv4(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      conversationHistory: [],
      state: 'idle',
    };
    this.sessions.set(session.sessionId, session);
    this.locks.set(session.sessionId, new Mutex());
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  remove(sessionId: string): boolean {
    this.locks.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  listActive(): Session[] {
    return [...this.sessions.values()];
  }

  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActive > this.ttlMs) {
        this.remove(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Acquires the per-session mutex and runs fn with exclusive access.
   * Throws if the session doesn't exist.
   */
  async withSession<T>(sessionId: string, fn: (session: Session) => Promise<T>): Promise<T> {
    const mutex = this.locks.get(sessionId);
    if (!mutex) throw new Error(`Session not found: ${sessionId}`);
    return mutex.runExclusive(async () => {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      session.lastActive = Date.now();
      return fn(session);
    });
  }
}
