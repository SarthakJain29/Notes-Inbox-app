import type { Config } from './config.js';
import { LLMClassifier } from './ai/classifier.js';
import { InboxBot } from './core/bot.js';
import { NotesService } from './core/service.js';
import { SqliteStore } from './db/sqlite.js';
import type { NoteStore } from './db/store.js';
import { createAIServices, type AIServices } from './llm/index.js';

export interface App {
  store: NoteStore;
  ai: AIServices;
  service: NotesService;
  bot: InboxBot;
}

/** Wire storage + AI providers + service + bot brain together. Shared by Telegram, CLI and importer. */
export function createApp(cfg: Config, opts: { store?: NoteStore; log?: (m: string) => void } = {}): App {
  const log = opts.log ?? ((m: string) => console.log(`[notes-inbox] ${m}`));
  const store = opts.store ?? new SqliteStore(cfg.DATABASE_PATH);
  const ai = createAIServices(cfg, log);
  const classifier = new LLMClassifier(ai.llm, cfg.TIMEZONE, log);
  const service = new NotesService({ store, classifier, embedder: ai.embedder, timezone: cfg.TIMEZONE, log });
  return { store, ai, service, bot: new InboxBot(service) };
}
