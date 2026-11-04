import { describe, expect, it } from 'vitest';
import { extractJson, normalizeType, parseBatch, parseClassification } from '../src/ai/parse.js';

const Z = 'America/New_York';

describe('extractJson', () => {
  it('parses plain JSON', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it('strips code fences', () => expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it('finds JSON inside prose', () => expect(extractJson('Sure! Here you go: {"a":1} Hope that helps')).toEqual({ a: 1 }));
  it('throws on garbage', () => expect(() => extractJson('nope')).toThrow());
});

describe('normalizeType', () => {
  it.each([
    ['task', 'task'],
    ['TODO', 'task'],
    ['grocery', 'shopping'],
    ['Meeting Note', 'meeting'],
    ['link', 'reference'],
    ['banana', 'other'],
  ])('%s -> %s', (i, o) => expect(normalizeType(i)).toBe(o));
  it('handles non-strings', () => expect(normalizeType(42)).toBe('other'));
});

describe('parseClassification', () => {
  it('accepts a well-formed response', () => {
    const c = parseClassification(
      JSON.stringify({ type: 'shopping', title: 'Weekly groceries', tags: ['Home', '#food'], items: ['milk', '2 kg rice'], due: null, context: 'Stock up for the week.' }),
      'raw',
      Z,
    );
    expect(c).toEqual({ type: 'shopping', title: 'Weekly groceries', tags: ['home', 'food'], items: ['milk', '2 kg rice'], due: null, context: 'Stock up for the week.' });
  });

  it('tolerates fences, synonyms and object items', () => {
    const c = parseClassification('```json\n{"type":"to-do","title":"Call bank","items":[{"text":"ask about card"},{"name":"get statement"}, 3],"due":"2025-03-13T17:00"}\n```', 'raw', Z);
    expect(c.type).toBe('task');
    expect(c.items).toEqual(['ask about card', 'get statement']);
    expect(c.due).toBe('2025-03-13T17:00');
  });

  it('nulls impossible or malformed dates', () => {
    expect(parseClassification('{"type":"task","title":"x","due":"2025-02-31"}', 'x', Z).due).toBeNull();
    expect(parseClassification('{"type":"task","title":"x","due":"tomorrow"}', 'x', Z).due).toBeNull();
    expect(parseClassification('{"type":"task","title":"x","due":"2025-03-13"}', 'x', Z).due).toBe('2025-03-13');
  });

  it('falls back for missing title and unknown type', () => {
    const c = parseClassification('{"type":"???"}', 'Pick up the parcel from the post office on the high street', Z);
    expect(c.type).toBe('other');
    expect(c.title).toBe('Pick up the parcel from the post office on');
  });

  it('clamps long strings and tag counts', () => {
    const c = parseClassification(JSON.stringify({ type: 'idea', title: 'x'.repeat(300), tags: Array.from({ length: 20 }, (_, i) => `t${i}`), context: 'y'.repeat(500) }), 'raw', Z);
    expect(c.title.length).toBe(80);
    expect(c.tags).toHaveLength(6);
    expect(c.context.length).toBe(200);
  });

  it('strips list markers from items and drops empties', () => {
    const c = parseClassification('{"type":"shopping","title":"t","items":["- milk","2) eggs","  ","• bread","3 apples","2 kg rice"]}', 'raw', Z);
    expect(c.items).toEqual(['milk', 'eggs', 'bread', '3 apples', '2 kg rice']);
  });

  it('throws when the output is not an object', () => {
    expect(() => parseClassification('"just a string"', 'raw', Z)).toThrow();
  });
});

describe('parseBatch', () => {
  it('maps results by id', () => {
    const out = parseBatch('{"results":[{"id":1,"type":"idea","title":"B"},{"id":0,"type":"task","title":"A"}]}', ['a', 'b'], Z);
    expect(out.map((o) => o?.title)).toEqual(['A', 'B']);
  });
  it('accepts a bare array and positional ids', () => {
    const out = parseBatch('[{"type":"idea","title":"A"},{"type":"task","title":"B"}]', ['a', 'b'], Z);
    expect(out.map((o) => o?.type)).toEqual(['idea', 'task']);
  });
  it('leaves missing entries null', () => {
    const out = parseBatch('{"results":[{"id":0,"type":"idea","title":"A"}]}', ['a', 'b', 'c'], Z);
    expect(out[0]).not.toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
  });
  it('ignores out-of-range and duplicate ids', () => {
    const out = parseBatch('{"results":[{"id":0,"title":"first"},{"id":0,"title":"dupe"},{"id":9,"title":"x"}]}', ['a'], Z);
    expect(out[0]?.title).toBe('first');
  });
  it('throws without a results array', () => {
    expect(() => parseBatch('{"foo":1}', ['a'], Z)).toThrow();
  });
});
