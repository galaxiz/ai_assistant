import { describe, it, expect, vi, beforeEach } from 'vitest';
import { status } from '@grpc/grpc-js';
import { EventEmitter } from 'events';
import { CognitionClient } from './client.js';
import { isRetryable, withRetry } from './retry.js';
import { loadConfig } from './config.js';
import type { CognitionServiceStub } from './client.js';
import type { CognitionConfig } from './config.js';
import type { StreamChunk } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGrpcError(code: number, message = 'grpc error'): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function makeStub(overrides: Partial<CognitionServiceStub> = {}): CognitionServiceStub {
  return {
    complete: vi.fn(),
    streamComplete: vi.fn(),
    countTokens: vi.fn(),
    parseOutput: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function defaultConfig(): CognitionConfig {
  return {
    address: 'http://localhost:50051',
    timeoutMs: 5_000,
    maxRetries: 2,
    retryInitialDelayMs: 1, // keep tests fast
    retryMaxDelayMs: 10,
  };
}

// Resolve a unary stub call by invoking its callback.
function resolveUnary(stub: CognitionServiceStub, method: keyof CognitionServiceStub, response: unknown) {
  const mockFn = stub[method] as ReturnType<typeof vi.fn>;
  const [[, callback]] = mockFn.mock.calls;
  (callback as (err: null, res: unknown) => void)(null, response);
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('uses defaults when env vars are absent', () => {
    const cfg = loadConfig({});
    expect(cfg.address).toBe('http://localhost:50051');
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.timeoutMs).toBe(30_000);
  });

  it('reads values from env vars', () => {
    const cfg = loadConfig({
      ORCH_COGNITION_ENGINE_ADDRESS: 'http://ce:9090',
      ORCH_COGNITION_MAX_RETRIES: '5',
      ORCH_COGNITION_TIMEOUT_MS: '10000',
    });
    expect(cfg.address).toBe('http://ce:9090');
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.timeoutMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it.each([
    [status.UNAVAILABLE, true],
    [status.DEADLINE_EXCEEDED, true],
    [status.RESOURCE_EXHAUSTED, true],
    [status.NOT_FOUND, false],
    [status.INVALID_ARGUMENT, false],
    [status.INTERNAL, false],
  ])('status %i → %s', (code, expected) => {
    expect(isRetryable(makeGrpcError(code))).toBe(expected);
  });

  it('returns false for non-error values', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable('string')).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  const opts = { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 10 };

  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, opts)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeGrpcError(status.UNAVAILABLE))
      .mockResolvedValue('ok');
    expect(await withRetry(fn, opts)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-retryable error', async () => {
    const err = makeGrpcError(status.NOT_FOUND);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, opts)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and re-throws the last error', async () => {
    const err = makeGrpcError(status.UNAVAILABLE);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, opts)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

// ---------------------------------------------------------------------------
// CognitionClient — complete
// ---------------------------------------------------------------------------

describe('CognitionClient.complete', () => {
  let stub: CognitionServiceStub;
  let client: CognitionClient;

  beforeEach(() => {
    stub = makeStub();
    client = new CognitionClient(stub, defaultConfig());
  });

  it('resolves with the response from the stub', async () => {
    const response = { content: 'hello', modelUsed: 'gemini', inputTokens: 10, outputTokens: 5, finishReason: 'stop' };
    const req = { context: { sessionId: 's1', authToken: '' }, messages: [] };

    const promise = client.complete(req);
    resolveUnary(stub, 'complete', response);
    expect(await promise).toEqual(response);
  });

  it('retries on UNAVAILABLE then resolves', async () => {
    const completeMock = stub.complete as ReturnType<typeof vi.fn>;
    let call = 0;
    completeMock.mockImplementation((_req, cb) => {
      call++;
      if (call === 1) cb(makeGrpcError(status.UNAVAILABLE), null);
      else cb(null, { content: 'retry-ok' });
    });

    const result = await client.complete({ context: { sessionId: 's1', authToken: '' }, messages: [] });
    expect(result.content).toBe('retry-ok');
    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-retryable gRPC error', async () => {
    const err = makeGrpcError(status.PERMISSION_DENIED);
    (stub.complete as ReturnType<typeof vi.fn>).mockImplementation((_req, cb) => cb(err, null));

    await expect(
      client.complete({ context: { sessionId: 's1', authToken: '' }, messages: [] }),
    ).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// CognitionClient — countTokens
// ---------------------------------------------------------------------------

describe('CognitionClient.countTokens', () => {
  it('resolves with token count response', async () => {
    const stub = makeStub();
    const client = new CognitionClient(stub, defaultConfig());
    const response = { tokenCount: 42, fitsBudget: true, remainingTokens: 958 };
    const req = { context: { sessionId: 's1', authToken: '' }, messages: [] };

    const promise = client.countTokens(req);
    resolveUnary(stub, 'countTokens', response);
    expect(await promise).toEqual(response);
  });
});

// ---------------------------------------------------------------------------
// CognitionClient — parseOutput
// ---------------------------------------------------------------------------

describe('CognitionClient.parseOutput', () => {
  it('resolves with parsed JSON response', async () => {
    const stub = makeStub();
    const client = new CognitionClient(stub, defaultConfig());
    const response = { parsedJson: '{"key":"value"}', repaired: false, rePrompted: false };
    const req = { context: { sessionId: 's1', authToken: '' }, rawResponse: '{"key":"value"}' };

    const promise = client.parseOutput(req);
    resolveUnary(stub, 'parseOutput', response);
    expect(await promise).toEqual(response);
  });
});

// ---------------------------------------------------------------------------
// CognitionClient — streamComplete
// ---------------------------------------------------------------------------

describe('CognitionClient.streamComplete', () => {
  it('yields chunks from the stream', async () => {
    const stub = makeStub();
    const client = new CognitionClient(stub, defaultConfig());

    const chunks: StreamChunk[] = [
      { content: 'Hello', done: false },
      { content: ' world', done: false },
      { content: '', done: true },
    ];

    // Simulate a Node.js readable stream as an async iterable.
    const fakeStream = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i < chunks.length) return { value: chunks[i++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };

    (stub.streamComplete as ReturnType<typeof vi.fn>).mockReturnValue(fakeStream);

    const req = { context: { sessionId: 's1', authToken: '' }, messages: [] };
    const received: StreamChunk[] = [];
    for await (const chunk of client.streamComplete(req)) {
      received.push(chunk);
    }
    expect(received).toEqual(chunks);
  });

  it('propagates stream errors', async () => {
    const stub = makeStub();
    const client = new CognitionClient(stub, defaultConfig());
    const streamErr = new Error('stream broke');

    const fakeStream = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<never> {
            throw streamErr;
          },
        };
      },
    };

    (stub.streamComplete as ReturnType<typeof vi.fn>).mockReturnValue(fakeStream);

    const req = { context: { sessionId: 's1', authToken: '' }, messages: [] };
    await expect(async () => {
      for await (const _ of client.streamComplete(req)) { /* drain */ }
    }).rejects.toBe(streamErr);
  });
});

// ---------------------------------------------------------------------------
// CognitionClient — close
// ---------------------------------------------------------------------------

describe('CognitionClient.close', () => {
  it('delegates to the stub', () => {
    const stub = makeStub();
    const client = new CognitionClient(stub, defaultConfig());
    client.close();
    expect(stub.close).toHaveBeenCalledOnce();
  });
});
