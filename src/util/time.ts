import { DateTime } from 'luxon';

export interface ParsedDue {
  /** ISO timestamp in UTC. For date-only values this is local midnight at the start of that day. */
  iso: string;
  hasTime: boolean;
}

/**
 * Parse a local date (`YYYY-MM-DD`) or local date-time (`YYYY-MM-DDTHH:mm`) in the given IANA zone.
 * Returns null for anything else (including impossible dates).
 */
export function parseLocalDue(value: string | null | undefined, zone: string): ParsedDue | null {
  if (!value) return null;
  const v = value.trim();
  const hasTime = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(v);
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!hasTime && !isDate) return null;
  const dt = DateTime.fromISO(v.replace(' ', 'T').slice(0, 16), { zone });
  if (!dt.isValid) return null;
  return { iso: dt.toUTC().toISO()!, hasTime };
}

export function toLocal(iso: string, zone: string): DateTime {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** "Mon 3 Nov", plus " 14:30" if the due date has a time. */
export function formatDue(iso: string, hasTime: boolean, zone: string): string {
  const d = toLocal(iso, zone);
  return d.toFormat('ccc d LLL') + (hasTime ? d.toFormat(' HH:mm') : '');
}

export function formatShortDateTime(iso: string, zone: string): string {
  return toLocal(iso, zone).toFormat('d LLL, HH:mm');
}

/** Start and end (UTC ISO) of the local calendar day containing `now`, shifted by `offsetDays`. */
export function dayBounds(now: DateTime, offsetDays = 0): { start: string; end: string } {
  const s = now.startOf('day').plus({ days: offsetDays });
  return { start: s.toUTC().toISO()!, end: s.plus({ days: 1 }).toUTC().toISO()! };
}
