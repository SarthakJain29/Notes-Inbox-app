import { describe, expect, it } from 'vitest';
import { parseCapture } from '../src/ai/capture.js';

describe('parseCapture', () => {
  it('passes plain text through', () => {
    expect(parseCapture('buy milk')).toEqual({ content: 'buy milk', title: null, typeHint: null, tags: [] });
  });

  it('extracts #tags and strips them from the content', () => {
    const r = parseCapture('call mom #family #Urgent about the trip');
    expect(r.tags).toEqual(['family', 'urgent']);
    expect(r.content).toBe('call mom about the trip');
  });

  it('does not treat #1 or mid-word # as a tag', () => {
    expect(parseCapture('Issue #123 is open').tags).toEqual([]);
    expect(parseCapture('C# is fun').tags).toEqual([]);
  });

  it('dedupes tags', () => {
    expect(parseCapture('x #a #A #a').tags).toEqual(['a']);
  });

  it('parses "title: content"', () => {
    const r = parseCapture('Kitchen reno: get three quotes before April');
    expect(r.title).toBe('Kitchen reno');
    expect(r.content).toBe('get three quotes before April');
  });

  it('treats known prefixes as a type hint, not a title', () => {
    expect(parseCapture('idea: a bot that files notes')).toMatchObject({ typeHint: 'idea', title: null, content: 'a bot that files notes' });
    expect(parseCapture('TODO: renew passport')).toMatchObject({ typeHint: 'task', content: 'renew passport' });
    expect(parseCapture('buy: milk, eggs')).toMatchObject({ typeHint: 'shopping' });
  });

  it('drops neutral prefixes without forcing a type', () => {
    expect(parseCapture('note to self: check the oven')).toMatchObject({ typeHint: null, title: null, content: 'check the oven' });
  });

  it('does not treat URLs, times or long sentences as titles', () => {
    expect(parseCapture('https://example.com/page').title).toBeNull();
    expect(parseCapture('http: //x').title).toBeNull();
    expect(parseCapture('10: the meeting starts').title).toBeNull();
    expect(parseCapture('I really think we should consider moving the whole thing to next week: ok?').title).toBeNull();
  });

  it('requires whitespace after the colon', () => {
    expect(parseCapture('ratio 3:2 is fine').title).toBeNull();
    expect(parseCapture('meet at 5:30pm').title).toBeNull();
  });

  it('keeps multi-line bodies', () => {
    const r = parseCapture('Kitchen reno: get quotes\nask about tiles\ncheck budget');
    expect(r.title).toBe('Kitchen reno');
    expect(r.content).toBe('get quotes\nask about tiles\ncheck budget');
  });

  it('combines hint and tags', () => {
    expect(parseCapture('idea: gamify chores #family')).toMatchObject({ typeHint: 'idea', tags: ['family'], content: 'gamify chores' });
  });
});
