import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { App } from '../app.js';
import { htmlToPlain, type Reply } from '../core/reply.js';

export const MAX_MESSAGE = 4000; // Telegram limit is 4096; keep headroom

/** Split long text on line boundaries. */
export function chunkText(text: string, max = MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function toKeyboard(reply: Reply): InlineKeyboard | undefined {
  if (!reply.buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  reply.buttons.forEach((row, i) => {
    row.forEach((b) => kb.text(b.label.slice(0, 60), b.data));
    if (i < reply.buttons!.length - 1) kb.row();
  });
  return kb;
}

export interface TelegramOptions {
  token: string;
  allowedUserId: number;
  app: App;
  log?: (m: string) => void;
  /** Override the Bot API base URL (tests use a local fake server). */
  apiRoot?: string;
  /** Pre-supplied bot info skips the getMe call (tests). */
  botInfo?: ConstructorParameters<typeof Bot>[1] extends infer C ? (C extends { botInfo?: infer B } ? B : never) : never;
}

/** Send replies to a chat, falling back to plain text if Telegram rejects the HTML. */
export async function sendReplies(bot: Bot, chatId: number, replies: Reply[]): Promise<void> {
  for (const r of replies) {
    const chunks = chunkText(r.text);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const kb = last ? toKeyboard(r) : undefined;
      try {
        await bot.api.sendMessage(chatId, chunks[i]!, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
      } catch (err) {
        if (!/can't parse entities/i.test((err as Error).message)) throw err;
        await bot.api.sendMessage(chatId, htmlToPlain(chunks[i]!), { reply_markup: kb });
      }
    }
    if (r.document) await bot.api.sendDocument(chatId, new InputFile(Buffer.from(r.document.content, 'utf8'), r.document.filename));
  }
}

export function createTelegramBot(o: TelegramOptions): Bot {
  const log = o.log ?? ((m: string) => console.log(`[telegram] ${m}`));
  const bot = new Bot(o.token, { botInfo: o.botInfo, client: o.apiRoot ? { apiRoot: o.apiRoot } : undefined });
  const { app } = o;
  const ctxFor = (ctx: Context) => ({ userId: String(ctx.from!.id) });

  // Security: single-user allowlist. Everyone else is silently ignored.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== o.allowedUserId) {
      log(`ignored update from unauthorised user ${ctx.from?.id ?? 'unknown'}`);
      return;
    }
    await next();
  });

  bot.on('message:text', async (ctx) => {
    await ctx.replyWithChatAction('typing').catch(() => {});
    const replies = await app.bot.handleText(ctxFor(ctx), ctx.message.text);
    await sendReplies(bot, ctx.chat.id, replies);
  });

  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const transcriber = app.ai.transcriber;
    if (!transcriber) {
      await ctx.reply('🎙 Voice notes need a GROQ_API_KEY for transcription (see developer.md). Send it as text for now.');
      return;
    }
    await ctx.replyWithChatAction('typing').catch(() => {});
    const media = ctx.message.voice ?? ctx.message.audio!;
    if ((media.file_size ?? 0) > 20 * 1024 * 1024) {
      await ctx.reply('That audio is over 20 MB, which is more than I can download. Try a shorter one.');
      return;
    }
    let text: string;
    try {
      const file = await ctx.getFile();
      const res = await fetch(`https://api.telegram.org/file/bot${o.token}/${file.file_path}`);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const audio = new Uint8Array(await res.arrayBuffer());
      const name = file.file_path?.split('/').pop() ?? 'voice.ogg';
      text = await transcriber.transcribe(audio, name, ctx.message.voice ? 'audio/ogg' : (ctx.message.audio?.mime_type ?? 'audio/mpeg'));
    } catch (err) {
      log(`transcription failed: ${(err as Error).message}`);
      await ctx.reply("🎙 Sorry, I couldn't transcribe that voice note. Please try again or send text.");
      return;
    }
    if (!/[\p{L}\p{N}]/u.test(text)) {
      await ctx.reply("🎙 I couldn't make out any words in that voice note.");
      return;
    }
    const replies = await app.bot.capture(ctxFor(ctx), text, 'voice', `🎙 <i>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 600)}</i>`);
    await sendReplies(bot, ctx.chat.id, replies);
  });

  bot.on('callback_query:data', async (ctx) => {
    const res = await app.bot.handleCallback(ctxFor(ctx), ctx.callbackQuery.data);
    if (!res) {
      await ctx.answerCallbackQuery({ text: 'Unknown action' });
      return;
    }
    await ctx.answerCallbackQuery({ text: res.toast });
    try {
      await ctx.editMessageText(res.reply.text, { parse_mode: 'HTML', reply_markup: toKeyboard(res.reply) ?? new InlineKeyboard(), link_preview_options: { is_disabled: true } });
    } catch (err) {
      if (!/not modified/i.test((err as Error).message)) log(`edit failed: ${(err as Error).message}`);
    }
  });

  bot.on('message', async (ctx) => {
    await ctx.reply('I can handle text and voice notes. Send me something to file! (/help)');
  });

  bot.catch(async (err) => {
    log(`handler error: ${err.error instanceof Error ? err.error.stack : String(err.error)}`);
    try {
      await err.ctx.reply('⚠️ Something went wrong filing that. Your message was not lost from the chat — try again in a moment.');
    } catch {
      /* ignore */
    }
  });

  return bot;
}

export const BOT_COMMANDS = [
  { command: 'tasks', description: 'Open tasks' },
  { command: 'shopping', description: 'Shopping list' },
  { command: 'ideas', description: 'Ideas' },
  { command: 'meetings', description: 'Meeting notes' },
  { command: 'links', description: 'Saved references' },
  { command: 'recent', description: 'Latest notes' },
  { command: 'search', description: 'Find notes by meaning' },
  { command: 'digest', description: "Today's digest" },
  { command: 'help', description: 'Help' },
];
