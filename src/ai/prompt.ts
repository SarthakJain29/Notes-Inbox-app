import type { DateTime } from 'luxon';
import type { NoteType } from '../types.js';

export interface PromptInput {
  content: string;
  userTitle?: string | null;
  typeHint?: NoteType | null;
  userTags?: string[];
  /** Original timestamp (ISO, local) when importing old notes. */
  sentAt?: string | null;
}

const SCHEMA_DOC = `Each note becomes one JSON object with these keys:
- "type": one of "task", "shopping", "meeting", "idea", "reference", "journal", "other"
    task = something the user has to do; shopping = things to buy (even a single item);
    meeting = notes from a meeting/call/conversation; idea = a thought/concept/project idea;
    reference = a link, quote, fact, recommendation or "something I heard" worth keeping; journal = personal reflection/diary; other = anything else.
- "title": clean, specific title, max 8 words, no trailing punctuation. Use the user's own title if one is given.
- "tags": 0-5 short lowercase topical tags (single words or kebab-case). Always include the user's own tags if given. No type names as tags.
- "items": array of strings. Split shopping lists / checklists into one entry per item (e.g. "milk", "2 kg rice"); for meeting notes list the action items; for a task with several sub-steps list them. Empty array otherwise.
- "due": the deadline or reminder date as local time "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (24h), only if the note states or clearly implies one ("tomorrow", "by Friday", "at 6pm"). Resolve relative dates against the current date given. null if none.
- "context": ONE short sentence (max 20 words) on why the user probably saved this / what it is for. Do not just repeat the title.
Rules: respond with JSON only. Never invent facts, dates or items that are not in the note. Keep the user's language for title/items/context.`;

export function systemPrompt(now: DateTime): string {
  return `You are the filing assistant of a personal notes inbox. The user dumps raw notes; you structure them so they can be found later.
Current date/time: ${now.toFormat("cccc, yyyy-MM-dd HH:mm")} (timezone ${now.zoneName}).

${SCHEMA_DOC}

Output format for ONE note: a single JSON object.`;
}

export function batchSystemPrompt(now: DateTime): string {
  return `You are the filing assistant of a personal notes inbox. The user dumps raw notes; you structure them so they can be found later.
Current date/time: ${now.toFormat("cccc, yyyy-MM-dd HH:mm")} (timezone ${now.zoneName}).

${SCHEMA_DOC}

You will receive several notes, each with a numeric "id". Output format: {"results":[{"id":0,...},{"id":1,...}]} with exactly one result object per input note, each including its "id" plus the keys above. When a note carries a "sent_at" timestamp, resolve relative dates against that moment instead of the current date and only return a "due" if it is still meaningful.`;
}

function describe(p: PromptInput): string {
  const lines = [`NOTE:\n"""\n${p.content}\n"""`];
  if (p.userTitle) lines.push(`User-provided title: ${p.userTitle}`);
  if (p.typeHint) lines.push(`User says the type is: ${p.typeHint}`);
  if (p.userTags?.length) lines.push(`User-provided tags: ${p.userTags.join(', ')}`);
  if (p.sentAt) lines.push(`sent_at: ${p.sentAt}`);
  return lines.join('\n');
}

export function userPrompt(p: PromptInput): string {
  return describe(p);
}

export function batchUserPrompt(ps: PromptInput[]): string {
  return ps.map((p, i) => `### id ${i}\n${describe(p)}`).join('\n\n');
}
