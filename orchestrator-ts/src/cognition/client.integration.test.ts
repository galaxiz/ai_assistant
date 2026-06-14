/**
 * Integration tests — require a running Cognition Engine.
 * Skipped automatically unless ORCH_COGNITION_ENGINE_ADDRESS is set.
 */
import { describe, it, expect } from 'vitest';
import { CognitionClient } from './client.js';
import { loadConfig } from './config.js';

const CE_ADDRESS = process.env.ORCH_COGNITION_ENGINE_ADDRESS;
const skip = !CE_ADDRESS;

describe.skipIf(skip)('CognitionClient integration', () => {
  const config = loadConfig(process.env);
  const client = CognitionClient.fromConfig(config);

  it('countTokens returns a non-negative count', async () => {
    const res = await client.countTokens({
      context: { sessionId: 'integration-test', authToken: '' },
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.tokenCount).toBeGreaterThanOrEqual(0);
  });

  it('complete returns a non-empty response', async () => {
    const res = await client.complete({
      context: { sessionId: 'integration-test', authToken: '' },
      messages: [{ role: 'user', content: 'Say exactly: pong' }],
    });
    expect(res.content.length).toBeGreaterThan(0);
  });
});
