import { DateTime } from 'luxon';

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

export interface WhatsAppMessage {
  /** ISO UTC timestamp. */
  timestamp: string;
  sender: string;
  text: string;
}

export interface ParseResult {
  messages: WhatsAppMessage[];
  dateOrder: DateOrder;
  /** True when dd/mm vs mm/dd could not be determined from the data and the default was used. */
  dateOrderGuessed: boolean;
  authors: Record<string, number>;
  skipped: { system: number; media: number; empty: number };
}

// Optional LRM/RLM marks and a leading "[" (iOS). Android uses " - " between time and sender.
const HEADER =
  /^[\u200e\u200f\u202a-\u202e]*\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:[\s\u202f\u00a0]*([AaPp])\.?[Mm]\.?)?\]?[\s\u202f\u00a0]*(?:-[\s\u202f\u00a0]+)?([\s\S]*)$/;

/** Lines WhatsApp itself generates. Matched against the whole message text, so real notes are never dropped by a loose keyword. */
const SYSTEM_PATTERNS = [
  /^messages and calls are end-to-end encrypted/i,
  /end-to-end encrypted\. no one outside of this chat/i,
  /^you deleted this message\.?$/i,
  /^this message was deleted\.?$/i,
  /^[\u200e\u200f]*(you )?(created|changed|joined|left|added|removed)\b.{0,80}\b(group|subject|description|icon|using this group's invite link)\b/i,
  /^your security code with .{1,60} changed/i,
  /^missed (voice|video) call/i,
  /^waiting for this message\./i,
];

const MEDIA_PATTERNS = [
  /^[\u200e\u200f]*<?(media|image|video|audio|sticker|gif|document|voice message|contact card|video note)( omitted|\s+omitted)>?$/i,
  /^[\u200e\u200f]*<attached: .+>$/i,
  /\(file attached\)$/i,
  /^[\u200e\u200f]*(image|video|audio|sticker|gif|document|ptt)[- ]\d+.*(\.jpg|\.mp4|\.opus|\.webp|\.pdf)/i,
];

export function isSystemText(text: string): boolean {
  return SYSTEM_PATTERNS.some((p) => p.test(text));
}

export function isMediaPlaceholder(text: string): boolean {
  const t = text.trim();
  return MEDIA_PATTERNS.some((p) => p.test(t));
}

interface RawLine {
  a: number;
  b: number;
  c: number;
  hour: number;
  minute: number;
  second: number;
  ampm: string | null;
  rest: string;
}

/** Decide whether the export uses day-first, month-first or year-first dates. */
export function detectDateOrder(triples: [number, number, number][], fallback: DateOrder = 'dmy'): { order: DateOrder; guessed: boolean } {
  if (triples.length && triples.every(([a]) => a > 31)) return { order: 'ymd', guessed: false };
  if (triples.some(([a]) => a > 12)) return { order: 'dmy', guessed: false };
  if (triples.some(([, b]) => b > 12)) return { order: 'mdy', guessed: false };
  return { order: fallback, guessed: true };
}

function splitSender(rest: string): { sender: string; text: string } | null {
  const idx = rest.indexOf(': ');
  if (idx <= 0 || idx > 60) return null;
  const sender = rest.slice(0, idx).replace(/^[\u200e\u200f~\s]+/, '').trim();
  // Colons inside a sentence (e.g. "Reminder at 5: call mom") are not senders in system lines, but system lines have no ": " near the start in practice.
  return sender ? { sender, text: rest.slice(idx + 2) } : null;
}

/**
 * Parse a WhatsApp "Export chat" .txt file (iOS and Android layouts, 12h/24h clocks,
 * multi-line messages). System messages and media placeholders are dropped.
 */
export function parseWhatsAppChat(
  content: string,
  opts: { zone?: string; dateOrder?: DateOrder | 'auto'; fallbackOrder?: DateOrder } = {},
): ParseResult {
  const zone = opts.zone ?? 'UTC';
  const lines = content.replace(/^\ufeff/, '').split(/\r?\n/);

  // Pass 1: split into logical entries (header line + continuation lines).
  const entries: { raw: RawLine; extra: string[] }[] = [];
  for (const line of lines) {
    const m = HEADER.exec(line);
    if (m) {
      entries.push({
        raw: { a: +m[1]!, b: +m[2]!, c: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: m[6] ? +m[6] : 0, ampm: m[7]?.toLowerCase() ?? null, rest: m[8]! },
        extra: [],
      });
    } else if (entries.length) {
      entries[entries.length - 1]!.extra.push(line);
    }
  }

  const forced = opts.dateOrder && opts.dateOrder !== 'auto' ? opts.dateOrder : null;
  const detected = detectDateOrder(entries.map((e) => [e.raw.a, e.raw.b, e.raw.c]), opts.fallbackOrder ?? 'dmy');
  const order = forced ?? detected.order;

  const result: ParseResult = {
    messages: [],
    dateOrder: order,
    dateOrderGuessed: forced ? false : detected.guessed,
    authors: {},
    skipped: { system: 0, media: 0, empty: 0 },
  };

  for (const { raw, extra } of entries) {
    const full = [raw.rest, ...extra].join('\n').replace(/\s+$/, '');
    const split = splitSender(full);
    // No "Sender: " prefix means a system line (Android), e.g. "Messages and calls are end-to-end encrypted..."
    if (!split || isSystemText(split.text.replace(/[\u200e\u200f]/g, '').trim())) {
      result.skipped.system++;
      continue;
    }
    const text = split.text.replace(/[\u200e\u200f]/g, '').trim();
    if (!text) {
      result.skipped.empty++;
      continue;
    }
    if (isMediaPlaceholder(text)) {
      result.skipped.media++;
      continue;
    }

    let year: number, month: number, day: number;
    if (order === 'ymd') [year, month, day] = [raw.a, raw.b, raw.c];
    else if (order === 'mdy') [month, day, year] = [raw.a, raw.b, raw.c];
    else [day, month, year] = [raw.a, raw.b, raw.c];
    if (year < 100) year += 2000;
    let hour = raw.hour;
    if (raw.ampm) hour = (hour % 12) + (raw.ampm === 'p' ? 12 : 0);
    const dt = DateTime.fromObject({ year, month, day, hour, minute: raw.minute, second: raw.second }, { zone });
    if (!dt.isValid) {
      result.skipped.system++;
      continue;
    }

    result.authors[split.sender] = (result.authors[split.sender] ?? 0) + 1;
    result.messages.push({ timestamp: dt.toUTC().toISO()!, sender: split.sender, text });
  }
  return result;
}
