import type { Logger } from '../utils/logger.js';

export interface SessionMapOptions {
  idleTtlMs: number;
  /** How often the sweep timer fires. Defaults to idleTtlMs / 2. */
  sweepIntervalMs?: number;
}

interface SessionEntry {
  orchestratorSessionId: string;
  lastActiveAt: number;
}

/** Composite key for a platform user in a channel. */
export interface SessionKey {
  platform: string;
  platformUserId: string;
  channelId: string;
}

function toMapKey(k: SessionKey): string {
  return `${k.platform}:${k.platformUserId}:${k.channelId}`;
}

export class SessionMap {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly idleTtlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly logger: Logger;

  constructor(opts: SessionMapOptions, logger: Logger) {
    this.idleTtlMs = opts.idleTtlMs;
    this.logger = logger;
    const sweepMs = opts.sweepIntervalMs ?? Math.max(opts.idleTtlMs / 2, 1000);
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    // Allow the process to exit even if the timer is still scheduled.
    this.sweepTimer.unref?.();
  }

  /** Retrieve the Orchestrator session ID for a platform user, if live. */
  get(key: SessionKey): string | undefined {
    const k = toMapKey(key);
    const entry = this.entries.get(k);
    if (!entry) return undefined;
    if (Date.now() - entry.lastActiveAt > this.idleTtlMs) {
      this.entries.delete(k);
      this.logger.debug({ key: k }, 'Session expired on access');
      return undefined;
    }
    // Refresh TTL on access ("idle" semantics).
    entry.lastActiveAt = Date.now();
    return entry.orchestratorSessionId;
  }

  /** Store or update the mapping. */
  set(key: SessionKey, orchestratorSessionId: string): void {
    this.entries.set(toMapKey(key), {
      orchestratorSessionId,
      lastActiveAt: Date.now(),
    });
  }

  /** Delete a mapping explicitly (e.g. user sends /reset). */
  delete(key: SessionKey): void {
    this.entries.delete(toMapKey(key));
  }

  /**
   * Delete all entries whose internal map key starts with `prefix`.
   * Used for bulk resets (e.g. Slack /reset clears the DM key AND all thread
   * keys derived from the same channel: `slack:teamId:channelId` and
   * `slack:teamId:channelId:threadTs`).
   * Returns the number of entries deleted.
   */
  deleteByKeyPrefix(prefix: string): number {
    let deleted = 0;
    for (const k of this.entries.keys()) {
      if (k === prefix || k.startsWith(`${prefix}:`)) {
        this.entries.delete(k);
        deleted++;
      }
    }
    return deleted;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Stop the background sweep timer (call on shutdown). */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private sweep(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [k, entry] of this.entries) {
      if (now - entry.lastActiveAt > this.idleTtlMs) {
        this.entries.delete(k);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.debug({ evicted }, 'Session sweep evicted entries');
    }
  }
}
