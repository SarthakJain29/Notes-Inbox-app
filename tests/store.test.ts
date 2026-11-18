import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/db/sqlite.js';
import type { NewNote } from '../src/db/store.js';

const base: NewNote = { userId: 'u', rawText: 'raw', source: 'cli', type: 'task', title: 't', context: '', tags: ['a'], items: [{ text: 'x', done: false }], dueAt: null, dueHasTime: false, processedBy: 'mock' };

describe('SqliteStore', () => {
  it('round-trips a note including JSON fields', async () => {
    const s = new SqliteStore(':memory:');
    const n = await s.insert({ ...base, dueAt: '2025-01-01T00:00:00.000Z', dueHasTime: true });
    expect(await s.get('u', n.id)).toMatchObject({ tags: ['a'], items: [{ text: 'x', done: false }], dueHasTime: true, status: 'open' });
  });

  it('scopes reads and writes by user', async () => {
    const s = new SqliteStore(':memory:');
    const n = await s.insert(base);
    expect(await s.get('other', n.id)).toBeNull();
    expect(await s.update('other', n.id, { title: 'hacked' })).toBeNull();
    expect((await s.get('u', n.id))!.title).toBe('t');
    expect(await s.list({ userId: 'other' })).toEqual([]);
  });

  it('stores and reads back embeddings, filtered by model', async () => {
    const s = new SqliteStore(':memory:');
    const n = await s.insert(base);
    await s.setEmbedding(n.id, 'm1', [0.5, -0.25, 1]);
    const hit = await s.withEmbeddings('u', 'm1');
    expect(Array.from(hit[0]!.vector)).toEqual([0.5, -0.25, 1]);
    expect(await s.withEmbeddings('u', 'm2')).toEqual([]);
    expect((await s.missingEmbeddings('u', 'm2', 10)).map((x) => x.id)).toEqual([n.id]);
    expect(await s.missingEmbeddings('u', 'm1', 10)).toEqual([]);
  });

  it('enforces unique import hashes per user', async () => {
    const s = new SqliteStore(':memory:');
    await s.insert({ ...base, importHash: 'h' });
    expect(await s.hasImportHash('u', 'h')).toBe(true);
    expect(await s.hasImportHash('v', 'h')).toBe(false);
    await expect(s.insert({ ...base, importHash: 'h' })).rejects.toThrow();
    await s.insert({ ...base, userId: 'v', importHash: 'h' });
  });

  it('list filters by type/status and orders', async () => {
    const s = new SqliteStore(':memory:');
    const a = await s.insert({ ...base, title: 'a', createdAt: '2025-01-01T00:00:00.000Z' });
    const b = await s.insert({ ...base, title: 'b', type: 'idea', createdAt: '2025-01-02T00:00:00.000Z' });
    await s.update('u', a.id, { status: 'deleted' });
    expect((await s.list({ userId: 'u' })).map((n) => n.title)).toEqual(['b']);
    expect((await s.list({ userId: 'u', status: 'deleted' })).map((n) => n.title)).toEqual(['a']);
    expect((await s.list({ userId: 'u', types: ['task'] })).length).toBe(0);
    expect((await s.list({ userId: 'u', types: ['idea'] }))[0]!.id).toBe(b.id);
  });

  it('meta key/value upserts', async () => {
    const s = new SqliteStore(':memory:');
    expect(await s.getMeta('k')).toBeNull();
    await s.setMeta('k', '1');
    await s.setMeta('k', '2');
    expect(await s.getMeta('k')).toBe('2');
  });

  it('counts open notes by type', async () => {
    const s = new SqliteStore(':memory:');
    await s.insert(base);
    await s.insert({ ...base, type: 'idea' });
    await s.insert({ ...base, status: 'done' });
    expect(await s.counts('u')).toEqual({ task: 1, idea: 1 });
  });
});
