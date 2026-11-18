import { NOTE_TYPES, type Note, type NoteType } from '../types.js';
import { digestButtons, digestText, noteButtons, noteCard, noteLine, noteList, refileButtons, reminderButtons, reminderText, shoppingList, typeLabel } from './format.js';
import { esc, type Reply } from './reply.js';
import type { NotesService } from './service.js';

const HELP = `<b>📥 Notes Inbox</b>
Send me anything — a task, shopping list, meeting note, idea, link, or a voice note. I'll file it for you.

<b>Tips</b>
• <code>Title: content</code> sets your own title
• <code>#tag</code> adds tags
• <code>idea: …</code> / <code>todo: …</code> / <code>buy: …</code> forces the type

<b>Commands</b>
/tasks — open tasks
/shopping — shopping list
/ideas — your ideas
/meetings — meeting notes
/links — saved references
/recent — latest notes
/search &lt;question&gt; — find notes by meaning
/show &lt;id&gt; · /done &lt;id&gt; · /delete &lt;id&gt; · /type &lt;id&gt; &lt;type&gt;
/digest — today's digest now
/reprocess — re-run AI on notes filed offline
/reindex — rebuild search vectors
/export — download everything as JSON`;

export interface BotContext {
  userId: string;
}

/**
 * Transport-neutral brain: text/commands/button presses in, Replies out.
 * Telegram and the CLI simulator both call this, so they behave identically.
 */
export class InboxBot {
  constructor(private readonly svc: NotesService) {}

  /** Handle any incoming text (plain note or /command). */
  async handleText(ctx: BotContext, text: string): Promise<Reply[]> {
    const trimmed = text.trim();
    if (!trimmed) return [{ text: 'Send me some text or a voice note.' }];
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (cmd) return this.handleCommand(ctx, cmd[1]!.toLowerCase(), (cmd[2] ?? '').trim());
    return this.capture(ctx, trimmed, 'telegram');
  }

  async capture(ctx: BotContext, text: string, source: string, preface?: string): Promise<Reply[]> {
    const note = await this.svc.capture(ctx.userId, text, { source });
    const card = noteCard(note, this.svc.timezone, this.svc.now());
    return [{ text: preface ? `${preface}\n\n${card}` : card, buttons: noteButtons(note) }];
  }

  async handleCommand(ctx: BotContext, cmd: string, arg: string): Promise<Reply[]> {
    const { userId } = ctx;
    const tz = this.svc.timezone;
    const now = this.svc.now();
    switch (cmd) {
      case 'start':
      case 'help':
        return [{ text: HELP }];
      case 'tasks': {
        const notes = await this.svc.tasks(userId);
        return [{ text: noteList('✅ Open tasks', notes, tz, now, 'No open tasks 🎉'), buttons: doneButtons(notes) }];
      }
      case 'shopping': {
        const notes = await this.svc.byType(userId, 'shopping');
        return [{ text: shoppingList(notes), buttons: doneButtons(notes, '✅ Bought') }];
      }
      case 'ideas':
        return [{ text: noteList('💡 Ideas', await this.svc.byType(userId, 'idea', 15), tz, now, 'No ideas yet.') }];
      case 'meetings':
        return [{ text: noteList('🗣️ Meeting notes', await this.svc.byType(userId, 'meeting', 15), tz, now, 'No meeting notes yet.') }];
      case 'links':
      case 'refs':
        return [{ text: noteList('🔗 References', await this.svc.byType(userId, 'reference', 15), tz, now, 'Nothing saved yet.') }];
      case 'journal':
        return [{ text: noteList('📓 Journal', await this.svc.byType(userId, 'journal', 15), tz, now, 'Nothing yet.') }];
      case 'recent':
        return [{ text: noteList('🕘 Recent', await this.svc.recent(userId, 10), tz, now, 'Nothing yet. Send me a note!') }];
      case 'search':
      case 'find': {
        if (!arg) return [{ text: 'Usage: <code>/search what did I want to ask the landlord?</code>' }];
        const hits = await this.svc.search(userId, arg);
        if (!hits.length) return [{ text: `No notes found for “${esc(arg)}”.` }];
        const lines = hits.map((h) => `${noteLine(h.note, tz, now)}${h.note.context ? `\n   <i>${esc(h.note.context)}</i>` : ''}`);
        return [{ text: `🔎 <b>Results for “${esc(arg)}”</b>\n${lines.join('\n')}\n\nTap /show &lt;id&gt; for details.` }];
      }
      case 'show': {
        const note = await this.noteFromArg(userId, arg);
        if (typeof note === 'string') return [{ text: note }];
        return [{ text: noteCard(note, tz, now, `#${note.id}`) + `\n\n<i>Original:</i>\n${esc(note.rawText.slice(0, 1500))}`, buttons: noteButtons(note) }];
      }
      case 'done': {
        const note = await this.noteFromArg(userId, arg);
        if (typeof note === 'string') return [{ text: note }];
        const u = await this.svc.markDone(userId, note.id);
        return [{ text: `✔ Done: ${esc(u!.title)}`, buttons: noteButtons(u!) }];
      }
      case 'delete':
      case 'del': {
        const note = await this.noteFromArg(userId, arg);
        if (typeof note === 'string') return [{ text: note }];
        const u = await this.svc.remove(userId, note.id);
        return [{ text: `🗑 Deleted: ${esc(u!.title)}`, buttons: noteButtons(u!) }];
      }
      case 'type':
      case 'refile': {
        const [idStr, typeStr] = arg.split(/\s+/);
        const type = parseType(typeStr);
        const id = Number((idStr ?? '').replace('#', ''));
        if (!id || !type) return [{ text: `Usage: <code>/type 12 idea</code>\nTypes: ${NOTE_TYPES.join(', ')}` }];
        const u = await this.svc.refile(userId, id, type);
        if (!u) return [{ text: `I can't find note #${id}.` }];
        return [{ text: noteCard(u, tz, now, `Re-filed #${u.id}`), buttons: noteButtons(u) }];
      }
      case 'digest':
        return this.digest(userId);
      case 'reprocess': {
        const r = await this.svc.reprocess(userId);
        return [{ text: r.tried ? `Re-processed ${r.improved}/${r.tried} notes that were filed offline.` : 'Nothing to re-process 👍' }];
      }
      case 'reindex': {
        const r = await this.svc.reindex(userId);
        return [{ text: r.done ? `Indexed ${r.done} notes${r.remaining ? ` (${r.remaining}+ remaining — run again)` : ''}.` : 'Search index is up to date 👍' }];
      }
      case 'export': {
        const all = await this.svc.storeRef.all(userId);
        return [{ text: `Exported ${all.length} notes.`, document: { filename: 'notes-inbox-export.json', content: JSON.stringify(all, null, 2) } }];
      }
      default:
        return [{ text: `Unknown command /${esc(cmd)}. Try /help.` }];
    }
  }

  /** Handle an inline-button press. Returns the replacement text/buttons (for editing the message). */
  async handleCallback(ctx: BotContext, data: string): Promise<{ reply: Reply; toast?: string } | null> {
    const { userId } = ctx;
    const tz = this.svc.timezone;
    const now = this.svc.now();
    const [action, idStr, arg] = data.split(':');
    const id = Number(idStr);
    if (!action || !Number.isFinite(id)) return null;
    const render = (n: Note | null, toast?: string) =>
      n ? { reply: { text: noteCard(n, tz, now, `#${n.id}`), buttons: noteButtons(n) }, toast } : { reply: { text: `Note #${id} no longer exists.` }, toast: 'Not found' };

    switch (action) {
      case 'done':
        return render(await this.svc.markDone(userId, id), 'Marked done ✔');
      case 'reopen':
        return render(await this.svc.reopen(userId, id), 'Reopened');
      case 'del': {
        const n = await this.svc.remove(userId, id);
        return n ? { reply: { text: `🗑 Deleted: ${esc(n.title)}`, buttons: noteButtons(n) }, toast: 'Deleted' } : render(null);
      }
      case 'undel':
        return render(await this.svc.restore(userId, id), 'Restored');
      case 'show':
        return render(await this.svc.get(userId, id));
      case 'refile': {
        const n = await this.svc.get(userId, id);
        return n ? { reply: { text: `Re-file <b>${esc(n.title)}</b> as…`, buttons: refileButtons(n) } } : render(null);
      }
      case 'type': {
        const type = parseType(arg);
        if (!type) return null;
        return render(await this.svc.refile(userId, id, type), `Filed as ${typeLabel(type)}`);
      }
      case 'snz': {
        if (arg !== '1h' && arg !== 'tomorrow') return null;
        const n = await this.svc.snooze(userId, id, arg);
        return n ? { reply: { text: `⏰ Snoozed: ${esc(n.title)}`, buttons: noteButtons(n) }, toast: 'Snoozed' } : render(null);
      }
      default:
        return null;
    }
  }

  async digest(userId: string): Promise<Reply[]> {
    const d = await this.svc.digestData(userId);
    return [{ text: digestText(d, this.svc.timezone, this.svc.now()), buttons: digestButtons(d) }];
  }

  reminder(n: Note): Reply {
    return { text: reminderText(n, this.svc.timezone), buttons: reminderButtons(n) };
  }

  private async noteFromArg(userId: string, arg: string): Promise<Note | string> {
    const id = Number(arg.replace('#', '').trim());
    if (!id) return 'Give me a note id, e.g. <code>/show 12</code>.';
    const n = await this.svc.get(userId, id);
    return n && n.status !== 'deleted' ? n : `I can't find note #${id}.`;
  }
}

function parseType(s: string | undefined): NoteType | null {
  if (!s) return null;
  const k = s.toLowerCase();
  const aliases: Record<string, NoteType> = { meetings: 'meeting', ideas: 'idea', tasks: 'task', todo: 'task', link: 'reference', note: 'other' };
  const t = aliases[k] ?? k;
  return (NOTE_TYPES as readonly string[]).includes(t) ? (t as NoteType) : null;
}

function doneButtons(notes: Note[], label = '✅'): { label: string; data: string }[][] {
  return notes.slice(0, 8).map((n) => [{ label: `${label} #${n.id} ${n.title.slice(0, 26)}`, data: `done:${n.id}` }]);
}
