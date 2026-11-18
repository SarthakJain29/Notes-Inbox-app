import { DateTime } from 'luxon';
import type { Note, NoteType } from '../types.js';
import { NOTE_TYPES, TYPE_EMOJI } from '../types.js';
import { formatDue, toLocal } from '../util/time.js';
import type { DigestData } from './service.js';
import { esc, type Button } from './reply.js';

const TYPE_LABEL: Record<NoteType, string> = {
  task: 'Task',
  shopping: 'Shopping',
  meeting: 'Meeting note',
  idea: 'Idea',
  reference: 'Reference',
  journal: 'Journal',
  other: 'Note',
};

export const typeLabel = (t: NoteType) => TYPE_LABEL[t];

function tagLine(n: Note): string {
  return n.tags.length ? `🏷 ${n.tags.map((t) => `#${esc(t)}`).join(' ')}` : '';
}

function dueLine(n: Note, zone: string, now: DateTime): string {
  if (!n.dueAt) return '';
  const overdue = n.status === 'open' && (n.dueHasTime ? DateTime.fromISO(n.dueAt) < now : toLocal(n.dueAt, zone).endOf('day') < now);
  return `${overdue ? '🔴 Overdue' : '⏰ Due'} ${formatDue(n.dueAt, n.dueHasTime, zone)}`;
}

function itemLines(n: Note, max = 12): string[] {
  const lines = n.items.slice(0, max).map((i) => `${i.done ? '☑' : '☐'} ${esc(i.text)}`);
  if (n.items.length > max) lines.push(`… +${n.items.length - max} more`);
  return lines;
}

/** Full card shown right after capture and for /show. */
export function noteCard(n: Note, zone: string, now: DateTime, heading?: string): string {
  const lines = [
    `${TYPE_EMOJI[n.type]} <b>${heading ?? `Saved #${n.id}`}</b> · ${TYPE_LABEL[n.type]}${n.status === 'done' ? ' · ✔ done' : ''}`,
    `<b>${esc(n.title)}</b>`,
    ...itemLines(n),
    dueLine(n, zone, now),
    tagLine(n),
    n.context ? `<i>💭 ${esc(n.context)}</i>` : '',
    n.processedBy === 'heuristic' ? '<i>(filed offline — AI unavailable; /reprocess later)</i>' : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** One-line summary used in lists. */
export function noteLine(n: Note, zone: string, now: DateTime): string {
  const bits = [`${TYPE_EMOJI[n.type]} <b>#${n.id}</b> ${esc(n.title)}`];
  if (n.status === 'done') bits.push('✔');
  const due = dueLine(n, zone, now);
  if (due) bits.push(`· ${due}`);
  if (n.items.length) bits.push(`· ${n.items.filter((i) => !i.done).length}/${n.items.length} items`);
  return bits.join(' ');
}

export function noteList(heading: string, notes: Note[], zone: string, now: DateTime, empty: string): string {
  if (!notes.length) return `<b>${heading}</b>\n${empty}`;
  return `<b>${heading}</b>\n` + notes.map((n) => noteLine(n, zone, now)).join('\n');
}

export function shoppingList(notes: Note[]): string {
  if (!notes.length) return '<b>🛒 Shopping</b>\nNothing on the list. Send me “buy milk, eggs” to add some.';
  const parts = notes.map((n) => {
    const body = n.items.length ? itemLines(n, 30).join('\n') : esc(n.title);
    return `<b>#${n.id}</b>\n${body}`;
  });
  return `<b>🛒 Shopping</b>\n\n${parts.join('\n\n')}`;
}

/** Action buttons for one note. */
export function noteButtons(n: Note): Button[][] {
  if (n.status === 'deleted') return [[{ label: '↩️ Undo delete', data: `undel:${n.id}` }]];
  const row: Button[] = [];
  row.push(n.status === 'done' ? { label: '↩️ Reopen', data: `reopen:${n.id}` } : { label: '✅ Done', data: `done:${n.id}` });
  row.push({ label: '🗂 Re-file', data: `refile:${n.id}` });
  row.push({ label: '🗑 Delete', data: `del:${n.id}` });
  return [row];
}

export function refileButtons(n: Note): Button[][] {
  const row = (types: NoteType[]) => types.map((t) => ({ label: `${TYPE_EMOJI[t]} ${TYPE_LABEL[t]}${t === n.type ? ' ✓' : ''}`, data: `type:${n.id}:${t}` }));
  return [row(NOTE_TYPES.slice(0, 3) as NoteType[]), row(NOTE_TYPES.slice(3, 6) as NoteType[]), [...row(NOTE_TYPES.slice(6) as NoteType[]), { label: '« Back', data: `show:${n.id}` }]];
}

export function reminderButtons(n: Note): Button[][] {
  return [
    [
      { label: '✅ Done', data: `done:${n.id}` },
      { label: '⏰ +1h', data: `snz:${n.id}:1h` },
      { label: '🌅 Tomorrow', data: `snz:${n.id}:tomorrow` },
    ],
  ];
}

export function reminderText(n: Note, zone: string): string {
  return `⏰ <b>Reminder</b>\n${TYPE_EMOJI[n.type]} <b>#${n.id}</b> ${esc(n.title)}\n${n.dueAt ? formatDue(n.dueAt, n.dueHasTime, zone) : ''}`.trim();
}

/** Morning digest message. */
export function digestText(d: DigestData, zone: string, now: DateTime): string {
  const out: string[] = [`🌅 <b>Good morning!</b> ${now.toFormat('cccc d LLLL')}`];
  const sect = (title: string, notes: Note[]) => {
    if (!notes.length) return;
    out.push('', `<b>${title}</b>`, ...notes.slice(0, 10).map((n) => noteLine(n, zone, now)));
    if (notes.length > 10) out.push(`… +${notes.length - 10} more`);
  };
  sect('🔴 Overdue', d.overdue);
  sect('📅 Due today', d.dueToday);
  sect('🔜 Coming up (next 3 days)', d.upcoming);
  sect('📌 Open tasks, no date', d.undatedTasks.slice(0, 5));
  if (d.undatedTasks.length > 5) out.push(`… and ${d.undatedTasks.length - 5} more → /tasks`);
  const shopItems = d.shopping.reduce((acc, n) => acc + (n.items.length ? n.items.filter((i) => !i.done).length : 1), 0);
  if (shopItems) out.push('', `🛒 ${shopItems} item${shopItems === 1 ? '' : 's'} on your shopping list → /shopping`);
  if (!d.overdue.length && !d.dueToday.length && !d.upcoming.length && !d.undatedTasks.length) out.push('', 'Nothing open. Enjoy the clear head ✨');
  return out.join('\n');
}

export function digestButtons(d: DigestData): Button[][] {
  const actionable = [...d.overdue, ...d.dueToday].slice(0, 6);
  return actionable.map((n) => [{ label: `✅ #${n.id} ${n.title.slice(0, 28)}`, data: `done:${n.id}` }]);
}
