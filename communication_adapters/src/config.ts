import { z } from 'zod';

const ConfigSchema = z.object({
  // Core
  ORCHESTRATOR_URL: z.string().startsWith('ws', { message: 'ORCHESTRATOR_URL must start with ws:// or wss://' }),
  ORCH_AUTH_TOKEN: z.string().optional(),
  SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  /** How long to wait for the orchestrator to respond before timing out (seconds). */
  ORCHESTRATOR_REQUEST_TIMEOUT_SECS: z.coerce.number().int().positive().default(3600),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Health
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Telegram
  TELEGRAM_ENABLED: z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1').default('false'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z.string().url().or(z.literal('')).transform(v => v || undefined).optional(),
  /** Port Telegraf listens on for incoming webhook requests (443/80/88/8443 allowed by Telegram). */
  TELEGRAM_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(8443),

  // Slack
  SLACK_ENABLED: z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1').default('false'),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  /** Port for Slack HTTP (non-Socket-Mode) event delivery. */
  SLACK_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});

export type Config = z.infer<typeof ConfigSchema>;

function validateCrossFields(c: Config): string | null {
  if (c.TELEGRAM_ENABLED && !c.TELEGRAM_BOT_TOKEN) {
    return 'TELEGRAM_ENABLED=true requires TELEGRAM_BOT_TOKEN';
  }
  if (c.SLACK_ENABLED && (!c.SLACK_BOT_TOKEN || !c.SLACK_SIGNING_SECRET)) {
    return 'SLACK_ENABLED=true requires SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET';
  }
  return null;
}

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Configuration error:\n' + result.error.toString());
    process.exit(1);
  }
  const crossFieldError = validateCrossFields(result.data);
  if (crossFieldError) {
    console.error('Configuration error: ' + crossFieldError);
    process.exit(1);
  }
  return result.data;
}
