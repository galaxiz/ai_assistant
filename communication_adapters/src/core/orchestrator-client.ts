import WebSocket from 'ws';
import type { Logger } from '../utils/logger.js';
import type { AgentResponse, OrchestratorMessage, UserMessage } from './types.js';
import { isErrorResponse } from './types.js';

export interface OrchestratorClientOptions {
  url: string;
  authToken?: string;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxReconnectDelayMs?: number;
}

type ClientState = 'disconnected' | 'connecting' | 'connected' | 'closing';

interface PendingRequest {
  resolve: (r: AgentResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OrchestratorClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private readonly pending = new Map<string, PendingRequest>();

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly logger: Logger;

  constructor(opts: OrchestratorClientOptions, logger: Logger) {
    this.url = opts.url;
    this.headers = opts.authToken
      ? { Authorization: `Bearer ${opts.authToken}` }
      : {};
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 30_000;
    this.logger = logger;
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  /** Open the WebSocket connection. Resolves when the socket is open. */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;
    return this._openSocket();
  }

  /** Close the connection permanently (no reconnect). */
  async disconnect(): Promise<void> {
    this.state = 'closing';
    this._clearTimers();
    this._rejectAllPending(new Error('Client disconnecting'));
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.state = 'disconnected';
  }

  /**
   * Send a UserMessage and await the matching AgentResponse.
   *
   * Correlation: the Orchestrator echoes back session_id in every AgentResponse.
   * For new sessions (no session_id), the sentinel key '__new__' is used.
   * Only one concurrent in-flight request per session is allowed.
   */
  async sendMessage(msg: UserMessage): Promise<AgentResponse> {
    if (this.state !== 'connected' || !this.ws) {
      throw new Error('OrchestratorClient is not connected');
    }

    const correlationKey = msg.session_id ?? '__new__';

    if (this.pending.has(correlationKey)) {
      throw new Error(
        `A request with key "${correlationKey}" is already in-flight. ` +
        'Do not send concurrent messages for the same session.',
      );
    }

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationKey);
        reject(new Error(`Request timed out (key=${correlationKey})`));
      }, this.requestTimeoutMs);

      this.pending.set(correlationKey, { resolve, reject, timer });

      const payload = JSON.stringify(msg);
      this.ws!.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(correlationKey);
          reject(err);
        }
      });
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _openSocket(): Promise<void> {
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: this.headers });
      this.ws = ws;

      ws.once('open', () => {
        this.state = 'connected';
        this.reconnectAttempt = 0;
        this._startHeartbeat();
        this.logger.info({ url: this.url }, 'Connected to Orchestrator');
        resolve();
      });

      ws.once('error', (err: Error) => {
        if (this.state === 'connecting') {
          // Suppress re-emitting after open — handled by 'close'.
          reject(err);
        }
        this.logger.error({ err }, 'WebSocket error');
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this._handleMessage(data.toString());
      });

      ws.on('pong', () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = undefined;
        }
      });

      ws.on('close', (code, reason) => {
        this._stopHeartbeat();
        this.logger.info({ code, reason: reason.toString() }, 'WebSocket closed');
        if (this.state !== 'closing') {
          this._rejectAllPending(new Error('WebSocket closed unexpectedly'));
          this._scheduleReconnect();
        }
      });
    });
  }

  private _handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn({ raw }, 'Received non-JSON message from Orchestrator');
      return;
    }

    const msg = parsed as Record<string, unknown>;

    if (isErrorResponse(msg as unknown as OrchestratorMessage)) {
      const err = new Error(`Orchestrator error [${msg['code']}]: ${msg['error']}`);
      // Reject the single in-flight request if unambiguous.
      if (this.pending.size === 1) {
        const [[key, req]] = [...this.pending.entries()] as [[string, PendingRequest]];
        clearTimeout(req.timer);
        this.pending.delete(key);
        req.reject(err);
      } else {
        this.logger.error({ msg }, 'Received error response but cannot correlate to pending request');
      }
      return;
    }

    // Normal AgentResponse — correlate by session_id.
    const sessionId = msg['session_id'] as string | undefined;
    if (!sessionId) {
      this.logger.warn({ msg }, 'Received response without session_id');
      return;
    }

    // Try the specific session key first, then the new-session sentinel.
    const key = this.pending.has(sessionId) ? sessionId : '__new__';
    const req = this.pending.get(key);
    if (!req) {
      this.logger.warn({ session_id: sessionId }, 'Received response for unknown session');
      return;
    }
    clearTimeout(req.timer);
    this.pending.delete(key);
    req.resolve(msg as unknown as AgentResponse);
  }

  private _scheduleReconnect(): void {
    if (this.state === 'closing') return;
    this.state = 'connecting';
    const base = 1_000;
    const delay = Math.min(
      base * Math.pow(2, this.reconnectAttempt) * (0.8 + Math.random() * 0.4),
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempt++;
    this.logger.info(
      { attempt: this.reconnectAttempt, delayMs: Math.round(delay) },
      'Reconnecting to Orchestrator',
    );
    this.reconnectTimer = setTimeout(() => {
      this._openSocket().catch((err: unknown) => {
        this.logger.error({ err }, 'Reconnect attempt failed');
        this._scheduleReconnect();
      });
    }, delay);
  }

  private _startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        this.logger.warn('Pong timeout — terminating socket');
        this.ws?.terminate();
      }, this.pongTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private _clearTimers(): void {
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private _rejectAllPending(err: Error): void {
    for (const [key, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(err);
      this.pending.delete(key);
    }
  }
}
