import { z } from 'zod';
import { NOTE_TYPES, type Classification, type NoteType } from '../types.js';
import { parseLocalDue } from '../util/time.js';

const TYPE_SYNONYMS: Record<string, NoteType> = {
  todo: 'task',
  'to-do': 'task',
  'to_do': 'task',
  reminder: 'task',
  action: 'task',
  grocery: 'shopping',
  groceries: 'shopping',
  'shopping list': 'shopping',
  shopping_list: 'shopping',
  errand: 'shopping',
  'meeting note': 'meeting',
  'meeting notes': 'meeting',
  meeting_note: 'meeting',
  meetings: 'meeting',
  link: 'reference',
  url: 'reference',
  article: 'reference',
  fact: 'reference',
  note: 'other',
  misc: 'other',
  diary: 'journal',
  thought: 'journal',
};

export function normalizeType(v: unknown): NoteType {
  if (typeof v !== 'string') return 'other';
  const k = v.trim().toLowerCase();
  if ((NOTE_TYPES as readonly string[]).includes(k)) return k as NoteType;
  return TYPE_SYNONYMS[k] ?? 'other';
}

const rawSchema = z
  .object({
    type: z.unknown().optional(),
    title: z.unknown().optional(),
    tags: z.unknown().optional(),
    items: z.unknown().optional(),
    due: z.unknown().optional(),
    context: z.unknown().optional(),
  })
  .passthrough();

/** Pull a JSON value out of model output, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [trimmed, fenced?.[1]?.trim()];
  const firstObj = trimmed.indexOf('{');
  const lastObj = trimmed.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(trimmed.slice(firstObj, lastObj + 1));
  const firstArr = trimmed.indexOf('[');
  const lastArr = trimmed.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(trimmed.slice(firstArr, lastArr + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  throw new Error('No valid JSON found in model output');
}

function cleanString(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function cleanTags(v: unknown, max = 6): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const t of arr) {
    if (typeof t !== 'string') continue;
    const tag = t
      .trim()
      .replace(/^#/, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

export function cleanItems(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const it of v) {
    const text =
      typeof it === 'string'
        ? it
        : it && typeof it === 'object' && typeof (it as { text?: unknown }).text === 'string'
          ? (it as { text: string }).text
          : typeof (it as { name?: unknown })?.name === 'string'
            ? (it as { name: string }).name
            : '';
    const t = text.replace(/\s+/g, ' ').trim().replace(/^[-*•\d.)\s]+/, '').slice(0, 200);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Turn one raw model object into a validated Classification.
 * Never throws for sloppy-but-recoverable output: unknown types become "other",
 * bad dates become null, missing titles fall back to the first words of `fallbackText`.
 */
export function toClassification(raw: unknown, fallbackText: string, zone: string): Classification {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Model output is not an object');
  const o = parsed.data;

  const type = normalizeType(o.type);
  let title = cleanString(o.title, 80);
  if (!title) title = fallbackTitle(fallbackText);

  const dueRaw = typeof o.due === 'string' ? o.due.trim() : '';
  const due = parseLocalDue(dueRaw, zone) ? dueRaw.replace(' ', 'T').slice(0, dueRaw.includes(':') ? 16 : 10) : null;

  return {
    type,
    title,
    tags: cleanTags(o.tags),
    items: cleanItems(o.items),
    due,
    context: cleanString(o.context, 200),
  };
}

export function fallbackTitle(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? text).trim().replace(/https?:\/\/\S+/g, (u) => u.replace(/^https?:\/\/(www\.)?/, ''));
  const words = first.split(/\s+/).slice(0, 9).join(' ');
  return (words.length > 70 ? words.slice(0, 67) + '…' : words) || 'Untitled note';
}

/** Parse the model's single-note response. */
export function parseClassification(text: string, fallbackText: string, zone: string): Classification {
  return toClassification(extractJson(text), fallbackText, zone);
}

/** Parse a batch response: `{"results":[...]}` or a bare array, one entry per input (by `id` or position). */
export function parseBatch(text: string, fallbackTexts: string[], zone: string): (Classification | null)[] {
  const json = extractJson(text);
  const arr: unknown[] | null = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { results?: unknown }).results)
      ? (json as { results: unknown[] }).results
      : null;
  if (!arr) throw new Error('Batch output has no results array');
  const out: (Classification | null)[] = fallbackTexts.map(() => null);
  arr.forEach((entry, pos) => {
    const idRaw = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
    const id = typeof idRaw === 'number' ? idRaw : typeof idRaw === 'string' && /^\d+$/.test(idRaw) ? Number(idRaw) : pos;
    if (id < 0 || id >= out.length || out[id]) return;
    try {
      out[id] = toClassification(entry, fallbackTexts[id]!, zone);
    } catch {
      /* leave null -> caller falls back */
    }
  });
  return out;
}
