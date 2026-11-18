import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectDateOrder, isMediaPlaceholder, parseWhatsAppChat } from '../src/import/whatsapp.js';

const ios = fs.readFileSync(new URL('../samples/whatsapp-self-chat.txt', import.meta.url), 'utf8');
const android = fs.readFileSync(new URL('../samples/whatsapp-android-self-chat.txt', import.meta.url), 'utf8');

describe('parseWhatsAppChat – iOS layout', () => {
  const r = parseWhatsAppChat(ios, { zone: 'UTC' });
  it('detects day-first dates from the data', () => {
    expect(r.dateOrder).toBe('dmy');
    expect(r.dateOrderGuessed).toBe(false);
  });
  it('skips system messages, media and deleted messages', () => {
    expect(r.messages).toHaveLength(8);
    expect(r.skipped).toEqual({ system: 2, media: 1, empty: 0 });
    expect(r.messages.some((m) => /end-to-end|attached|deleted/i.test(m.text))).toBe(false);
  });
  it('joins multi-line messages', () => {
    expect(r.messages[0]!.text).toBe('Buy milk, eggs, bread\nand coffee beans');
  });
  it('parses timestamps', () => {
    expect(r.messages[0]!.timestamp).toBe('2024-02-03T09:15:12.000Z');
  });
  it('counts authors', () => expect(r.authors).toEqual({ Sarthak: 8 }));
  it('keeps colons inside message text', () => {
    expect(r.messages.find((m) => m.text.startsWith('Meeting with Priya'))!.text).toContain('Priya: agreed');
  });
});

describe('parseWhatsAppChat – Android layout', () => {
  const r = parseWhatsAppChat(android, { zone: 'UTC' });
  it('detects month-first dates and 12h clock', () => {
    expect(r.dateOrder).toBe('mdy');
    expect(r.messages[0]!.timestamp).toBe('2024-02-03T09:16:00.000Z');
    expect(r.messages[1]!.timestamp).toBe('2024-02-03T21:20:00.000Z');
  });
  it('drops "no sender" system lines and <Media omitted>', () => {
    expect(r.messages).toHaveLength(3);
    expect(r.skipped.system).toBe(1);
    expect(r.skipped.media).toBe(1);
  });
  it('keeps bullet continuation lines', () => {
    expect(r.messages[1]!.text).toBe('Book flights to Berlin for 22 March\n- check baggage\n- window seat');
  });
});

describe('parseWhatsAppChat – options', () => {
  it('honours the timezone', () => {
    const r = parseWhatsAppChat('[13/02/2024, 17:45:00] Me: hi', { zone: 'America/New_York' });
    expect(r.messages[0]!.timestamp).toBe('2024-02-13T22:45:00.000Z');
  });
  it('lets the caller force the date order', () => {
    const r = parseWhatsAppChat('[03/04/2024, 10:00:00] Me: hi', { zone: 'UTC', dateOrder: 'mdy' });
    expect(r.messages[0]!.timestamp).toBe('2024-03-04T10:00:00.000Z');
  });
  it('reports a guessed order when ambiguous', () => {
    const r = parseWhatsAppChat('[03/04/2024, 10:00:00] Me: hi', { zone: 'UTC' });
    expect(r.dateOrderGuessed).toBe(true);
    expect(r.messages[0]!.timestamp).toBe('2024-04-03T10:00:00.000Z');
  });
  it('handles narrow no-break space before AM/PM and LRM marks (iOS 17+)', () => {
    const r = parseWhatsAppChat('‎[13/02/24, 5:45:00 PM] Me: ‎remember milk', { zone: 'UTC' });
    expect(r.messages[0]!.timestamp).toBe('2024-02-13T17:45:00.000Z');
    expect(r.messages[0]!.text).toBe('remember milk');
  });
  it('handles dotted German dates', () => {
    const r = parseWhatsAppChat('13.02.24, 17:45 - Me: Milch kaufen', { zone: 'UTC' });
    expect(r.messages[0]!.timestamp).toBe('2024-02-13T17:45:00.000Z');
  });
  it('handles 12 AM / 12 PM correctly', () => {
    const r = parseWhatsAppChat('1/20/24, 12:05 AM - Me: a\n1/20/24, 12:05 PM - Me: b', { zone: 'UTC' });
    expect(r.messages.map((m) => m.timestamp.slice(11, 16))).toEqual(['00:05', '12:05']);
  });
  it('ignores a leading preamble and BOM', () => {
    const r = parseWhatsAppChat('﻿garbage\n[13/02/2024, 17:45:00] Me: hi', { zone: 'UTC' });
    expect(r.messages).toHaveLength(1);
  });
  it('does not drop notes that merely contain words like "left" or "added"', () => {
    const r = parseWhatsAppChat('13/02/2024, 17:45 - Me: I left my keys; added milk to the list', { zone: 'UTC' });
    expect(r.messages).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('detectDateOrder', () => {
    expect(detectDateOrder([[13, 2, 2024]]).order).toBe('dmy');
    expect(detectDateOrder([[2, 13, 2024]]).order).toBe('mdy');
    expect(detectDateOrder([[2024, 2, 13]]).order).toBe('ymd');
    expect(detectDateOrder([[1, 2, 2024]], 'mdy')).toEqual({ order: 'mdy', guessed: true });
  });
  it('isMediaPlaceholder', () => {
    expect(isMediaPlaceholder('<Media omitted>')).toBe(true);
    expect(isMediaPlaceholder('<attached: 0001-PHOTO.jpg>')).toBe(true);
    expect(isMediaPlaceholder('image omitted')).toBe(true);
    expect(isMediaPlaceholder('my image of the week')).toBe(false);
  });
});
