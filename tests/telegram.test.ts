import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { InboxBot } from '../src/core/bot.js';
import { HashEmbedder, MockLLM } from '../src/llm/mock.js';
import { chunkText, createTelegramBot, toKeyboard } from '../src/telegram/bot.js';
import { makeApp } from './helpers.js';

const OWNER = 4242;

/** Minimal fake of the Telegram Bot API: records every call and answers ok. */
function fakeTelegram() {
  const calls: { method: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const method = req.url!.split('/').pop()!;
      let body: any = {};
      try { body = JSON.parse(data || '{}'); } catch { /* multipart */ }
      calls.push({ method, body });
      res.setHeader('content-type', 'application/json');
      if (method === 'sendMessage') res.end(JSON.stringify({ ok: true, result: { message_id: 1, date: 0, chat: { id: body.chat_id, type: 'private' }, text: body.text } }));
      else res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  return { calls, server };
}

let tg: ReturnType<typeof fakeTelegram>;
let apiRoot: string;
let app: App;

beforeEach(async () => {
  tg = fakeTelegram();
  await new Promise<void>((r) => tg.server.listen(0, r));
  apiRoot = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`;
  const m = makeApp();
  app = { store: m.store, service: m.service, bot: new InboxBot(m.service), ai: { llm: new MockLLM(), embedder: new HashEmbedder(), transcriber: null } };
});
afterEach(() => new Promise<void>((r) => tg.server.close(() => r())));

const botInfo = { id: 1, is_bot: true as const, first_name: 'N', username: 'notes_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
const mk = () => createTelegramBot({ token: 'T', allowedUserId: OWNER, app, apiRoot, botInfo, log: () => {} });
const textUpdate = (from: number, text: string, id = 1) => ({ update_id: id, message: { message_id: id, date: 0, chat: { id: from, type: 'private' as const, first_name: 'x' }, from: { id: from, is_bot: false, first_name: 'x' }, text } });

describe('Telegram adapter', () => {
  it('files a note from the allowed user and replies with buttons', async () => {
    const bot = mk();
    await bot.handleUpdate(textUpdate(OWNER, 'buy milk, eggs'));
    const send = tg.calls.find((c) => c.method === 'sendMessage')!;
    expect(send.body.chat_id).toBe(OWNER);
    expect(send.body.parse_mode).toBe('HTML');
    expect(send.body.text).toContain('Saved #1');
    expect(send.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(['done:1', 'refile:1', 'del:1']);
    expect(await app.service.get(String(OWNER), 1)).not.toBeNull();
  });

  it('SECURITY: ignores everyone else completely (no reply, nothing stored)', async () => {
    const bot = mk();
    await bot.handleUpdate(textUpdate(999, 'buy milk'));
    await bot.handleUpdate(textUpdate(999, '/tasks', 2));
    await bot.handleUpdate({ update_id: 3, callback_query: { id: 'c', chat_instance: 'x', from: { id: 999, is_bot: false, first_name: 'x' }, data: 'del:1', message: { message_id: 1, date: 0, chat: { id: 999, type: 'private' } } } } as any);
    expect(tg.calls.filter((c) => c.method !== 'getMe')).toEqual([]);
    expect(await app.service.storeRef.all('999')).toEqual([]);
  });

  it('handles button presses by editing the message and answering the callback', async () => {
    const bot = mk();
    await bot.handleUpdate(textUpdate(OWNER, 'call bank tomorrow'));
    await bot.handleUpdate({ update_id: 2, callback_query: { id: 'cb1', chat_instance: 'x', from: { id: OWNER, is_bot: false, first_name: 'x' }, data: 'done:1', message: { message_id: 1, date: 0, chat: { id: OWNER, type: 'private' }, text: 'x' } } } as any);
    expect(tg.calls.find((c) => c.method === 'answerCallbackQuery')!.body).toMatchObject({ callback_query_id: 'cb1', text: 'Marked done ✔' });
    expect(tg.calls.find((c) => c.method === 'editMessageText')!.body.text).toContain('✔ done');
    expect((await app.service.get(String(OWNER), 1))!.status).toBe('done');
  });

  it('explains voice notes are unavailable without a transcriber', async () => {
    const bot = mk();
    await bot.handleUpdate({ update_id: 5, message: { message_id: 5, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false, first_name: 'x' }, voice: { file_id: 'f', file_unique_id: 'u', duration: 3 } } } as any);
    expect(tg.calls.find((c) => c.method === 'sendMessage')!.body.text).toContain('GROQ_API_KEY');
  });

  it('sends an export as a document', async () => {
    const bot = mk();
    await bot.handleUpdate(textUpdate(OWNER, 'buy milk'));
    await bot.handleUpdate(textUpdate(OWNER, '/export', 2));
    expect(tg.calls.some((c) => c.method === 'sendDocument')).toBe(true);
  });
});

describe('helpers', () => {
  it('chunkText splits on line boundaries and never exceeds the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(90)}`).join('\n');
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
    expect(chunkText('x'.repeat(2500), 1000).map((c) => c.length)).toEqual([1000, 1000, 500]);
  });
  it('toKeyboard maps rows', () => {
    expect(toKeyboard({ text: 'x' })).toBeUndefined();
    const kb = toKeyboard({ text: 'x', buttons: [[{ label: 'A', data: 'a' }, { label: 'B', data: 'b' }], [{ label: 'C', data: 'c' }]] })!;
    expect(kb.inline_keyboard.map((r) => r.length)).toEqual([2, 1]);
  });
});
