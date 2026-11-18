import { describe, expect, it } from 'vitest';
import { guessDue, guessType, heuristicClassify, splitListItems } from '../src/ai/heuristic.js';
import { NOW } from './helpers.js';

describe('guessType', () => {
  it.each([
    ['https://example.com/article', 'reference'],
    ['buy milk and eggs', 'shopping'],
    ['Grocery list:\nmilk\neggs\nbread', 'shopping'],
    ['call the dentist tomorrow', 'task'],
    ['I need to renew my passport', 'task'],
    ['Meeting with Priya about the roadmap', 'meeting'],
    ['what if we built a notes app that files itself', 'idea'],
    ['Felt really tired today but proud', 'other'],
    ['I feel grateful for my team', 'journal'],
    ['heard from Rahul that Ichiran is great', 'reference'],
    ['random thought', 'other'],
  ])('%s -> %s', (text, type) => expect(guessType(text)).toBe(type));

  it('respects an explicit hint', () => expect(guessType('buy milk', 'idea')).toBe('idea'));
});

describe('guessDue (now = Wed 2025-03-12 10:00)', () => {
  it.each([
    ['call bank today', '2025-03-12'],
    ['call bank tomorrow', '2025-03-13'],
    ['dentist tomorrow at 5pm', '2025-03-13T17:00'],
    ['submit report by friday', '2025-03-14'],
    ['gym next monday', '2025-03-17'],
    ['same weekday is next week: wednesday', '2025-03-19'],
    ['in 3 days renew', '2025-03-15'],
    ['in 2 hours check oven', '2025-03-12T12:00'],
    ['call mom at 6:30 pm', '2025-03-12T18:30'],
    ['call mom at 9am', '2025-03-13T09:00'],
    ['pay rent 2025-04-01', '2025-04-01'],
    ['lunch at 12:30', '2025-03-12T12:30'],
    ['day after tomorrow dentist', '2025-03-14'],
    ['no date here', null],
  ])('%s -> %s', (text, due) => expect(guessDue(text, NOW)).toBe(due));
});

describe('splitListItems', () => {
  it('splits commas and "and"', () => expect(splitListItems('buy milk, eggs and bread')).toEqual(['milk', 'eggs', 'bread']));
  it('splits lines and drops bullets', () => expect(splitListItems('Shopping list:\n- milk\n- 2 kg rice\n- bread')).toEqual(['milk', '2 kg rice', 'bread']));
});

describe('splitListItems (multi-line)', () => {
  it('splits commas inside lines and strips a leading "and"', () => {
    expect(splitListItems('Buy milk, eggs, bread\nand coffee beans')).toEqual(['milk', 'eggs', 'bread', 'coffee beans']);
  });
});

describe('heuristicClassify', () => {
  it('builds a full classification', () => {
    const c = heuristicClassify({ content: 'buy milk, eggs and bread', userTags: ['home'] }, NOW);
    expect(c).toMatchObject({ type: 'shopping', items: ['milk', 'eggs', 'bread'], tags: ['home'] });
    expect(c.title).toContain('milk');
  });
  it('uses the user title and hint', () => {
    const c = heuristicClassify({ content: 'get three quotes', userTitle: 'Kitchen reno', typeHint: 'task' }, NOW);
    expect(c.title).toBe('Kitchen reno');
    expect(c.type).toBe('task');
  });
  it('tags links with the site name', () => {
    const c = heuristicClassify({ content: 'https://www.paulgraham.com/startupideas.html' }, NOW);
    expect(c.type).toBe('reference');
    expect(c.tags).toContain('paulgraham');
  });
  it('extracts a due date for tasks only', () => {
    expect(heuristicClassify({ content: 'call bank tomorrow at 3pm' }, NOW).due).toBe('2025-03-13T15:00');
    expect(heuristicClassify({ content: 'idea: app launching tomorrow' }, NOW).due).toBeNull();
  });
});
