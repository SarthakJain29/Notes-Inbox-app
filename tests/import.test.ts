import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMessages } from '../src/import/run.js';
import { parseWhatsAppChat } from '../src/import/whatsapp.js';
import { fakeLLM, makeApp, USER, ZONE } from './helpers.js';

const chat = fs.readFileSync(new URL('../samples/whatsapp-self-chat.txt', import.meta.url), 'utf8');
const opts = { userId: USER, delayMs: 0, sleep: async () => {} };

describe('importMessages', () => {
  it('imports with original timestamps and source=whatsapp (mock classifier)', async () => {
    const { service, classifier } = makeApp();
    const { messages } = parseWhatsAppChat(chat, { zone: ZONE });
    const s = await importMessages(service, classifier, messages, opts);
    expect(s).toMatchObject({ total: 8, imported: 8, duplicates: 0 });
    const all = await service.storeRef.all(USER);
    expect(all).toHaveLength(8);
    expect(all.every((n) => n.source === 'whatsapp' && n.importHash)).toBe(true);
    expect(all[0]!.createdAt).toBe(messages[0]!.timestamp);
    expect(all[0]!.type).toBe('shopping');
    expect(all[0]!.items.map((i) => i.text)).toEqual(['milk', 'eggs', 'bread', 'coffee beans']);
  });

  it('is idempotent and de-duplicates within a file', async () => {
    const { service, classifier } = makeApp();
    const { messages } = parseWhatsAppChat(chat, { zone: ZONE });
    await importMessages(service, classifier, messages, opts);
    const again = await importMessages(service, classifier, [...messages, messages[0]!], opts);
    expect(again).toMatchObject({ imported: 0, duplicates: 9 });
    expect(await service.storeRef.all(USER)).toHaveLength(8);
  });

  it('embeds imported notes in bulk so search works', async () => {
    const { service, classifier } = makeApp();
    const { messages } = parseWhatsAppChat(chat, { zone: ZONE });
    await importMessages(service, classifier, messages, opts);
    const hits = await service.search(USER, 'ramen');
    expect(hits[0]!.note.rawText).toContain('Ichiran');
  });

  it('uses one LLM call per batch and falls back per item when the model skips one', async () => {
    const llm = fakeLLM((user) => {
      const ids = [...user.matchAll(/### id (\d+)/g)].map((m) => Number(m[1]));
      // Answer for every id except the last one.
      return JSON.stringify({ results: ids.slice(0, -1).map((id) => ({ id, type: 'idea', title: `T${id}`, context: 'c' })) });
    });
    const { service, classifier } = makeApp({ llm });
    const { messages } = parseWhatsAppChat(chat, { zone: ZONE });
    const s = await importMessages(service, classifier, messages, { ...opts, batchSize: 4 });
    expect(llm.calls).toHaveLength(2);
    expect(s.imported).toBe(8);
    expect(s.heuristicFallbacks).toBe(2);
    const all = await service.storeRef.all(USER);
    expect(all.filter((n) => n.processedBy === 'fake')).toHaveLength(6);
  });

  it('drops past due dates but remembers them in the context', async () => {
    const llm = fakeLLM(() => JSON.stringify({ results: [{ id: 0, type: 'task', title: 'Call bank', due: '2024-02-04T10:00', context: 'Card issue.' }] }));
    const { service, classifier } = makeApp({ llm });
    await importMessages(service, classifier, [{ timestamp: '2024-02-03T09:20:00.000Z', sender: 'Me', text: 'call the bank tomorrow' }], opts);
    const [n] = await service.storeRef.all(USER);
    expect(n!.dueAt).toBeNull();
    expect(n!.context).toContain('originally due 2024-02-04 10:00');
  });

  it('can import old tasks as done', async () => {
    const { service, classifier } = makeApp();
    await importMessages(service, classifier, [{ timestamp: '2024-02-03T09:20:00.000Z', sender: 'Me', text: 'todo: renew passport' }], { ...opts, doneOlderThanDays: 30 });
    expect((await service.storeRef.all(USER))[0]!.status).toBe('done');
  });

  it('dry run writes nothing', async () => {
    const { service, classifier } = makeApp();
    const { messages } = parseWhatsAppChat(chat, { zone: ZONE });
    const s = await importMessages(service, classifier, messages, { ...opts, dryRun: true });
    expect(s.imported).toBe(8);
    expect(await service.storeRef.all(USER)).toHaveLength(0);
  });

  it('respects limit and reports progress', async () => {
    const { service, classifier } = makeApp();
    const { messages } = parseWhatsAppChat(chat, { zone: ZONE });
    const progress: number[] = [];
    const s = await importMessages(service, classifier, messages, { ...opts, limit: 3, batchSize: 2, onProgress: (p) => progress.push(p.processed) });
    expect(s.imported).toBe(3);
    expect(progress).toEqual([2, 3]);
  });
});
