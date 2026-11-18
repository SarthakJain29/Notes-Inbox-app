import type { NoteType } from '../types.js';

export interface ParsedCapture {
  /** Text with hashtags stripped; this is what the AI sees. */
  content: string;
  /** Explicit title from a "title: content" message. */
  title: string | null;
  /** Type forced by a "task: ..." / "idea: ..." style prefix. */
  typeHint: NoteType | null;
  /** #tags typed by the user, lowercased, without '#'. */
  tags: string[];
}

const TYPE_PREFIXES: Record<string, NoteType> = {
  task: 'task',
  todo: 'task',
  'to-do': 'task',
  'to do': 'task',
  remind: 'task',
  reminder: 'task',
  buy: 'shopping',
  shopping: 'shopping',
  groceries: 'shopping',
  grocery: 'shopping',
  meeting: 'meeting',
  mom: 'meeting',
  idea: 'idea',
  link: 'reference',
  ref: 'reference',
  reference: 'reference',
  read: 'reference',
  journal: 'journal',
  diary: 'journal',
};

/** Prefixes that carry no information: dropped without forcing a type. */
const NEUTRAL_PREFIXES = new Set(['note', 'notes', 'note to self', 'nts', 'fyi']);

const HASHTAG = /(^|\s)#([\p{L}][\p{L}\p{N}_-]{0,30})/gu;

/**
 * Light, deterministic pre-parse of a message:
 *  - `#tags` are lifted out
 *  - `idea: foo` / `todo: foo` set a type hint
 *  - `Some title: body` sets an explicit title (first line, <= 6 words, colon followed by whitespace)
 */
export function parseCapture(raw: string): ParsedCapture {
  let text = raw.trim();
  const tags: string[] = [];

  text = text.replace(HASHTAG, (_m, pre: string, tag: string) => {
    const t = tag.toLowerCase();
    if (!tags.includes(t)) tags.push(t);
    return pre;
  });
  text = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();

  let title: string | null = null;
  let typeHint: NoteType | null = null;

  const m = /^([^\n:]{1,60}?):[ \t]+([\s\S]+)$/.exec(text);
  if (m) {
    const prefix = m[1]!.trim();
    const rest = m[2]!.trim();
    const hint = TYPE_PREFIXES[prefix.toLowerCase()];
    const wordCount = prefix.split(/\s+/).length;
    const looksLikeUrlOrTime = /^(https?|ftp|mailto)$/i.test(prefix) || /^\d{1,2}$/.test(prefix);
    if (hint) {
      typeHint = hint;
      text = rest;
    } else if (NEUTRAL_PREFIXES.has(prefix.toLowerCase())) {
      text = rest;
    } else if (wordCount <= 6 && !looksLikeUrlOrTime && !/[.!?]$/.test(prefix) && rest.length > 0) {
      title = prefix;
      text = rest;
    }
  }

  return { content: text, title, typeHint, tags };
}
