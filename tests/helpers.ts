import { DateTime } from 'luxon';
import { LLMClassifier } from '../src/ai/classifier.js';
import { InboxBot } from '../src/core/bot.js';
import { NotesService } from '../src/core/service.js';
import { SqliteStore } from '../src/db/sqlite.js';
import { HashEmbedder, MockLLM } from '../src/llm/mock.js';
import type { LLMProvider } from '../src/llm/types.js';

export const ZONE = 'America/New_York';
/** Wednesday 12 March 2025, 10:00 in New York (EDT, UTC-4). */
export const NOW = DateTime.fromISO('2025-03-12T10:00:00', { zone: ZONE });
export const USER = 'u1';

export function makeApp(opts: { llm?: LLMProvider; now?: () => DateTime } = {}) {
  const store = new SqliteStore(':memory:');
  const llm = opts.llm ?? new MockLLM();
  const classifier = new LLMClassifier(llm, ZONE);
  const clock = { now: NOW };
  const service = new NotesService({
    store,
    classifier,
    embedder: new HashEmbedder(),
    timezone: ZONE,
    now: opts.now ?? (() => clock.now),
  });
  return { store, service, bot: new InboxBot(service), classifier, clock };
}

export function fakeLLM(respond: (user: string, system: string) => string | Error): LLMProvider & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    name: 'fake',
    isMock: false,
    calls,
    async generateJson(req) {
      calls.push(req);
      const r = respond(req.user, req.system);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
