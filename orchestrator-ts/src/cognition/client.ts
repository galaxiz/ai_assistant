import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { CognitionConfig } from './config.js';
import { withRetry } from './retry.js';
import type {
  CompleteRequest,
  CompleteResponse,
  CountTokensRequest,
  CountTokensResponse,
  ParseOutputRequest,
  ParseOutputResponse,
  StreamChunk,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolves to <repo-root>/proto/cognition.proto from src/cognition/ or dist/cognition/
const DEFAULT_PROTO_PATH = resolve(__dirname, '../../..', 'proto', 'cognition.proto');

// Untyped stub shape returned by @grpc/grpc-js dynamic loading.
export interface CognitionServiceStub {
  complete(req: unknown, callback: (err: Error | null, res: unknown) => void): void;
  streamComplete(req: unknown): grpc.ClientReadableStream<unknown>;
  countTokens(req: unknown, callback: (err: Error | null, res: unknown) => void): void;
  parseOutput(req: unknown, callback: (err: Error | null, res: unknown) => void): void;
  close(): void;
}

function callUnary<T>(
  stub: CognitionServiceStub,
  method: keyof Pick<CognitionServiceStub, 'complete' | 'countTokens' | 'parseOutput'>,
  req: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    stub[method](req, (err, res) => {
      if (err) reject(err);
      else resolve(res as T);
    });
  });
}

export function createStub(config: CognitionConfig, protoPath = DEFAULT_PROTO_PATH): CognitionServiceStub {
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(packageDef) as Record<string, unknown>;
  const cognition = pkg['cognition'] as Record<string, grpc.ServiceClientConstructor>;
  const ServiceClient = cognition['CognitionService'];

  // Strip http:// or https:// prefix — gRPC uses bare host:port.
  const address = config.address.replace(/^https?:\/\//, '');
  const credentials = config.address.startsWith('https://')
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();

  return new ServiceClient(address, credentials, {
    'grpc.keepalive_time_ms': 10_000,
    'grpc.keepalive_timeout_ms': 5_000,
    'grpc.keepalive_permit_without_calls': 1,
  }) as unknown as CognitionServiceStub;
}

export class CognitionClient {
  private readonly retryOpts: { maxRetries: number; initialDelayMs: number; maxDelayMs: number };

  constructor(
    private readonly stub: CognitionServiceStub,
    private readonly config: CognitionConfig,
  ) {
    this.retryOpts = {
      maxRetries: config.maxRetries,
      initialDelayMs: config.retryInitialDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
    };
  }

  static fromConfig(config: CognitionConfig, protoPath?: string): CognitionClient {
    return new CognitionClient(createStub(config, protoPath), config);
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    return withRetry(
      () => callUnary<CompleteResponse>(this.stub, 'complete', req),
      this.retryOpts,
    );
  }

  async *streamComplete(req: CompleteRequest): AsyncIterable<StreamChunk> {
    const call = this.stub.streamComplete(req);
    // Node 20+ streams implement AsyncIterable natively.
    for await (const chunk of call as unknown as AsyncIterable<unknown>) {
      yield chunk as StreamChunk;
    }
  }

  async countTokens(req: CountTokensRequest): Promise<CountTokensResponse> {
    return withRetry(
      () => callUnary<CountTokensResponse>(this.stub, 'countTokens', req),
      this.retryOpts,
    );
  }

  async parseOutput(req: ParseOutputRequest): Promise<ParseOutputResponse> {
    return withRetry(
      () => callUnary<ParseOutputResponse>(this.stub, 'parseOutput', req),
      this.retryOpts,
    );
  }

  close(): void {
    this.stub.close();
  }
}
