import 'dotenv/config';
import { DateTime } from 'luxon';
import { z } from 'zod';

const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(emptyToUndef, s.optional());

const schema = z.object({
  TELEGRAM_BOT_TOKEN: opt(z.string()),
  ALLOWED_TELEGRAM_USER_ID: opt(z.coerce.number().int().positive()),
  GEMINI_API_KEY: opt(z.string()),
  GROQ_API_KEY: opt(z.string()),
  LLM_PROVIDER: z.preprocess(emptyToUndef, z.enum(['auto', 'gemini', 'groq', 'mock']).default('auto')),
  GEMINI_MODEL: z.preprocess(emptyToUndef, z.string().default('gemini-flash-lite-latest,gemini-flash-latest')),
  GEMINI_EMBEDDING_MODEL: z.preprocess(emptyToUndef, z.string().default('gemini-embedding-001')),
  GROQ_MODEL: z.preprocess(emptyToUndef, z.string().default('openai/gpt-oss-120b,openai/gpt-oss-20b')),
  GROQ_WHISPER_MODEL: z.preprocess(emptyToUndef, z.string().default('whisper-large-v3-turbo')),
  TIMEZONE: z.preprocess(emptyToUndef, z.string().default('UTC')),
  DIGEST_HOUR: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(23).default(8)),
  DATABASE_PATH: z.preprocess(emptyToUndef, z.string().default('./data/notes.db')),
  BOT_MODE: z.preprocess(emptyToUndef, z.enum(['polling', 'webhook']).default('polling')),
  WEBHOOK_URL: opt(z.string().url()),
  WEBHOOK_SECRET: opt(z.string().min(8)),
  PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(3000)),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}\nSee .env.example`);
  }
  const cfg = parsed.data;
  if (!DateTime.local().setZone(cfg.TIMEZONE).isValid) {
    throw new Error(`Invalid configuration:\n  - TIMEZONE: "${cfg.TIMEZONE}" is not a valid IANA timezone (e.g. Europe/London)`);
  }
  return cfg;
}

/** Throws a helpful error if the Telegram-specific settings are missing. */
export function requireTelegramConfig(cfg: Config): {
  token: string;
  userId: number;
} {
  const missing: string[] = [];
  if (!cfg.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!cfg.ALLOWED_TELEGRAM_USER_ID) missing.push('ALLOWED_TELEGRAM_USER_ID');
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(' and ')}. Set them in .env (see developer.md), or use \`npm run simulate\` to try the bot without Telegram.`,
    );
  }
  return { token: cfg.TELEGRAM_BOT_TOKEN!, userId: cfg.ALLOWED_TELEGRAM_USER_ID! };
}
