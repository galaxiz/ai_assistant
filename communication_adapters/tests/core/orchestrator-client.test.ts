import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import pino from 'pino';
import { OrchestratorClient } from '../../src/core/orchestrator-client.js';
import type { AgentResponse, UserMessage } from '../../src/core/types.js';

const logger = pino({ level: 'silent' });

function makeServer(): Promise<{ wss: WebSocketServer; url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.once('listening', () => {
      const addr = wss.address() as { port: number };
      resolve({ wss, url: `ws://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => wss.close(() => resolve()));
}

describe('OrchestratorClient', () => {
  let wss: WebSocketServer;
  let url: string;
  let client: OrchestratorClient;

  beforeEach(async () => {
    ({ wss, url } = await makeServer());
  });

  afterEach(async () => {
    await client?.disconnect();
    await closeServer(wss);
  });

  it('connects successfully', async () => {
    client = new OrchestratorClient({ url }, logger);
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('sends Authorization header when authToken is set', async () => {
    const receivedHeaders: Record<string, string | string[] | undefined> = {};
    wss.on('connection', (_ws, req) => {
      Object.assign(receivedHeaders, req.headers);
    });
    client = new OrchestratorClient({ url, authToken: 'test-token' }, logger);
    await client.connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(receivedHeaders['authorization']).toBe('Bearer test-token');
  });

  it('does not send Authorization header when authToken is absent', async () => {
    const receivedHeaders: Record<string, string | string[] | undefined> = {};
    wss.on('connection', (_ws, req) => {
      Object.assign(receivedHeaders, req.headers);
    });
    client = new OrchestratorClient({ url }, logger);
    await client.connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(receivedHeaders['authorization']).toBeUndefined();
  });

  it('sendMessage resolves with AgentResponse', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as UserMessage;
        const response: AgentResponse = {
          session_id: msg.session_id ?? 'new-session-id',
          content: 'Hello from orchestrator',
          model_used: 'test-model',
          input_tokens: 5,
          output_tokens: 10,
        };
        ws.send(JSON.stringify(response));
      });
    });

    client = new OrchestratorClient({ url }, logger);
    await client.connect();
    const response = await client.sendMessage({ message: 'Hi' });
    expect(response.content).toBe('Hello from orchestrator');
    expect(response.session_id).toBe('new-session-id');
  });

  it('correlates responses by session_id for existing sessions', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as UserMessage;
        const response: AgentResponse = {
          session_id: msg.session_id ?? 'fallback',
          content: `reply for ${msg.session_id}`,
          model_used: 'test-model',
          input_tokens: 1,
          output_tokens: 1,
        };
        ws.send(JSON.stringify(response));
      });
    });

    client = new OrchestratorClient({ url }, logger);
    await client.connect();
    const response = await client.sendMessage({ session_id: 'abc-123', message: 'Hello' });
    expect(response.session_id).toBe('abc-123');
    expect(response.content).toBe('reply for abc-123');
  });

  it('sendMessage rejects on request timeout', async () => {
    // Server never responds.
    client = new OrchestratorClient({ url, requestTimeoutMs: 100 }, logger);
    await client.connect();
    await expect(client.sendMessage({ message: 'Hi' })).rejects.toThrow(/timed out/i);
  });

  it('reconnects after server closes connection', async () => {
    let connectionCount = 0;
    wss.on('connection', () => { connectionCount++; });

    client = new OrchestratorClient({ url, maxReconnectDelayMs: 50 }, logger);
    await client.connect();
    expect(connectionCount).toBe(1);

    // Force-close all server-side sockets.
    wss.clients.forEach((ws) => ws.terminate());

    await new Promise((r) => setTimeout(r, 300));
    expect(connectionCount).toBeGreaterThanOrEqual(2);
  });

  it('rejects pending requests on disconnect', async () => {
    client = new OrchestratorClient({ url, requestTimeoutMs: 5_000 }, logger);
    await client.connect();
    const pending = client.sendMessage({ session_id: 'abc', message: 'Hi' });
    await client.disconnect();
    await expect(pending).rejects.toThrow(/disconnecting/i);
  });

  it('throws if sendMessage called while not connected', async () => {
    client = new OrchestratorClient({ url }, logger);
    // Do not call connect()
    await expect(client.sendMessage({ message: 'Hi' })).rejects.toThrow(/not connected/i);
  });
});
