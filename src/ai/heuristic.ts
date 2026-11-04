import type { DateTime } from 'luxon';
import type { Classification, NoteType } from '../types.js';
import { cleanItems, cleanTags, fallbackTitle } from './parse.js';
import type { PromptInput } from './prompt.js';

const URL_RE = /https?:\/\/[^\s)]+/gi;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const TASK_START =
  /^(call|email|e-mail|text|message|book|pay|send|finish|submit|renew|schedule|fix|clean|cancel|check|follow up|reply|write|prepare|review|update|order|return|pick up|drop off|ask|remind|don'?t forget|remember to|need to|have to|must|todo|to-do)\b/i;
const TASK_ANY = /\b(need to|have to|must|don'?t forget|remember to|remind me|deadline|due (on|by)?|by (tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|end of))\b/i;
const SHOP_START = /^(buy|get|pick up|grab|grocer(y|ies)|shopping( list)?|need (some )?(milk|eggs|bread))\b/i;
const SHOP_WORDS =
  /\b(milk|eggs?|bread|butter|cheese|rice|flour|sugar|salt|oil|onions?|tomato(es)?|potato(es)?|bananas?|apples?|chicken|coffee|tea|detergent|shampoo|toothpaste|tissues?|toilet paper|vegetables?|fruits?|yogh?urt|pasta|cereal)\b/i;
const MEETING = /\b(meeting|met with|call with|standup|stand-up|sync|1:1|one-on-one|discussed|minutes|agenda|action items?|catch-?up with|attendees)\b/i;
const IDEA = /\b(idea|what if|we could|i could|maybe (i|we) (could|should)|would be (cool|nice|great)|startup|app that|side project|brainstorm)\b/i;
const JOURNAL = /\b(i feel|i felt|i('m| am) (so )?(happy|sad|tired|anxious|grateful|stressed|excited)|today i|grateful for|my day|dear diary)\b/i;
const REFERENCE = /\b(heard|recommend(ed|ation)?|read about|article|book recommendation|podcast|someone said|learned that|til\b|fun fact)\b/i;

function stripUrls(s: string): string {
  return s.replace(URL_RE, '').trim();
}

export function guessType(text: string, hint?: NoteType | null): NoteType {
  if (hint) return hint;
  const t = text.trim();
  const noUrl = stripUrls(t);
  if (URL_RE.test(t)) {
    URL_RE.lastIndex = 0;
    if (noUrl.length < 40) return 'reference';
  }
  URL_RE.lastIndex = 0;
  if (SHOP_START.test(t) || (SHOP_WORDS.test(t) && t.split('\n').length >= 2 && !TASK_START.test(t))) return 'shopping';
  if (MEETING.test(t)) return 'meeting';
  if (TASK_START.test(t) || TASK_ANY.test(t)) return 'task';
  if (IDEA.test(t)) return 'idea';
  if (JOURNAL.test(t)) return 'journal';
  if (REFERENCE.test(t)) return 'reference';
  if (SHOP_WORDS.test(t) && t.length < 80) return 'shopping';
  return 'other';
}

/** Best-effort relative date/time extraction used when no LLM is available. Returns local ISO string or null. */
export function guessDue(text: string, now: DateTime): string | null {
  const t = text.toLowerCase();
  let day: DateTime | null = null;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) {
    const d = now.set({ year: +iso[1]!, month: +iso[2]!, day: +iso[3]! }).startOf('day');
    if (d.isValid) day = d;
  }
  if (!day) {
    const inN = /\bin (\d{1,3}) (minute|min|hour|hr|day|week)s?\b/.exec(t);
    if (inN) {
      const n = +inN[1]!;
      const unit = inN[2]!;
      if (unit.startsWith('min')) return now.plus({ minutes: n }).toFormat("yyyy-MM-dd'T'HH:mm");
      if (unit.startsWith('h')) return now.plus({ hours: n }).toFormat("yyyy-MM-dd'T'HH:mm");
      day = now.plus({ days: unit === 'week' ? n * 7 : n }).startOf('day');
    }
  }
  if (!day) {
    if (/\bday after tomorrow\b/.test(t)) day = now.plus({ days: 2 }).startOf('day');
    else if (/\btomorrow\b/.test(t)) day = now.plus({ days: 1 }).startOf('day');
    else if (/\b(today|tonight|this evening)\b/.test(t)) day = now.startOf('day');
  }
  if (!day) {
    const wd = new RegExp(`\\b(next |this |on |by )?(${WEEKDAYS.join('|')})\\b`).exec(t);
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[2]!) + 1; // luxon: Mon=1
      let delta = (target - now.weekday + 7) % 7;
      if (delta === 0) delta = 7;
      day = now.plus({ days: delta }).startOf('day');
    }
  }

  const tm = /\b(?:at |by |@ ?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at |by )(\d{1,2}):(\d{2})\b/.exec(t);
  let hour: number | null = null;
  let minute = 0;
  if (tm) {
    if (tm[3]) {
      hour = +tm[1]! % 12 + (tm[3] === 'pm' ? 12 : 0);
      minute = tm[2] ? +tm[2] : 0;
    } else if (tm[4]) {
      hour = +tm[4];
      minute = +tm[5]!;
    }
    if (hour !== null && (hour > 23 || minute > 59)) hour = null;
  }

  if (!day && hour === null) return null;
  if (!day) {
    const candidate = now.startOf('day').set({ hour: hour!, minute });
    day = candidate > now ? now.startOf('day') : now.plus({ days: 1 }).startOf('day');
  }
  return hour !== null ? day.set({ hour, minute }).toFormat("yyyy-MM-dd'T'HH:mm") : day.toFormat('yyyy-MM-dd');
}

export function splitListItems(text: string): string[] {
  let body = text.replace(/^(buy|get|pick up|grab|shopping( list)?|grocer(y|ies))\s*:?\s*/i, '');
  body = stripUrls(body);
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : (lines[0] ?? '').split(/,|;|\band\b/i);
  return cleanItems(parts.map((p) => p.trim()).filter((p) => p.length > 0 && p.length < 60));
}

/** Offline classifier: used in mock mode and as a fallback when the LLM call fails. */
export function heuristicClassify(input: PromptInput, now: DateTime): Classification {
  const text = input.content;
  const type = guessType(text, input.typeHint);
  const urls = text.match(URL_RE) ?? [];
  URL_RE.lastIndex = 0;

  let items: string[] = [];
  if (type === 'shopping') items = splitListItems(text);
  else if (type === 'meeting' || type === 'task') {
    const bullets = text.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
    items = cleanItems(bullets);
  }

  const tags = [...(input.userTags ?? [])];
  if (urls[0]) {
    try {
      const host = new URL(urls[0]).hostname.replace(/^www\./, '').split('.').slice(-2, -1)[0];
      if (host) tags.push(host);
    } catch {
      /* ignore */
    }
  }

  let title = input.userTitle?.trim() || '';
  if (!title) {
    title = type === 'shopping' && items.length ? `Shopping: ${items.slice(0, 3).join(', ')}` : fallbackTitle(stripUrls(text) || text);
    title = title.slice(0, 80);
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  const due = type === 'task' || type === 'shopping' || type === 'meeting' ? guessDue(text, now) : null;

  const contextByType: Record<NoteType, string> = {
    task: 'Something to get done.',
    shopping: 'Things to pick up.',
    meeting: 'Notes to remember from a conversation.',
    idea: 'An idea worth coming back to.',
    reference: 'Saved for later reference.',
    journal: 'A personal reflection.',
    other: 'Saved for later.',
  };

  return { type, title, tags: cleanTags(tags), items, due, context: contextByType[type] };
}
