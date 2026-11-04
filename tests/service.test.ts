import { describe, expect, it } from 'vitest';
import { fakeLLM, makeApp, NOW, USER, ZONE } from './helpers.js';

describe('NotesService.capture (mock mode)', () => {
  it('files a shopping list with items, tags and an embedding', async () => {
    const { service, store } = makeApp();
    const n = await service.capture(USER, 'buy milk, eggs and bread #home');
    expect(n).toMatchObject({ type: 'shopping', tags: ['home'], status: 'open', processedBy: 'heuristic', source: 'telegram' });
    expect(n.items.map((i) => i.text)).toEqual(['milk', 'eggs', 'bread']);
    expect((await store.withEmbeddings(USER, 'mock-hash-1024')).map((e) => e.note.id)).toEqual([n.id]);
  });

  it('converts a local due time to UTC (EDT = UTC-4)', async () => {
    const { service } = makeApp();
    const n = await service.capture(USER, 'call dentist tomorrow at 5pm');
    expect(n.type).toBe('task');
    expect(n.dueHasTime).toBe(true);
    expect(n.dueAt).toBe('2025-03-13T21:00:00.000Z');
  });

  it('stores date-only due dates as local midnight', async () => {
    const { service } = makeApp();
    const n = await service.capture(USER, 'submit report by friday');
    expect(n.dueHasTime).toBe(false);
    expect(n.dueAt).toBe('2025-03-14T04:00:00.000Z');
  });

  it('applies user title, type hint and tags over the AI', async () => {
    const llm = fakeLLM(() => JSON.stringify({ type: 'other', title: 'AI title', tags: ['ai'], items: [], due: null, context: 'c' }));
    const { service } = makeApp({ llm });
    const n = await service.capture(USER, 'Kitchen reno: idea: new tiles #home');
    // "Kitchen reno" is the title; the remainder starts with a type-prefix-looking "idea:" that the AI still sees.
    expect(n.title).toBe('Kitchen reno');
    const n2 = await service.capture(USER, 'idea: wall-mounted desk #diy');
    expect(n2.type).toBe('idea');
    expect(n2.tags).toEqual(['diy', 'ai']);
  });

  it('uses the LLM result when it works', async () => {
    const llm = fakeLLM(() => JSON.stringify({ type: 'meeting', title: 'Sync with Priya', tags: ['work'], items: ['ship beta'], due: '2025-03-15', context: 'Decisions from the call.' }));
    const { service } = makeApp({ llm });
    const n = await service.capture(USER, 'long messy meeting text');
    expect(n).toMatchObject({ type: 'meeting', title: 'Sync with Priya', processedBy: 'fake' });
    expect(llm.calls[0]!.system).toContain('2025-03-12 10:00');
  });

  it('falls back to heuristics (and flags it) when the LLM errors or returns garbage', async () => {
    for (const bad of [new Error('HTTP 503'), 'not json at all']) {
      const { service } = makeApp({ llm: fakeLLM(() => bad) });
      const n = await service.capture(USER, 'buy milk');
      expect(n.processedBy).toBe('heuristic');
      expect(n.type).toBe('shopping');
    }
  });

  it('reprocess upgrades heuristic notes once the LLM is back', async () => {
    let healthy = false;
    const llm = fakeLLM(() => (healthy ? JSON.stringify({ type: 'task', title: 'Fixed title', context: 'ctx' }) : new Error('down')));
    const { service } = makeApp({ llm });
    const n = await service.capture(USER, 'something vague');
    expect(n.processedBy).toBe('heuristic');
    healthy = true;
    expect(await service.reprocess(USER)).toEqual({ improved: 1, tried: 1 });
    const after = await service.get(USER, n.id);
    expect(after).toMatchObject({ title: 'Fixed title', type: 'task', processedBy: 'fake' });
  });
});

describe('NotesService.search', () => {
  it('ranks relevant notes first and omits unrelated ones', async () => {
    const { service } = makeApp();
    await service.capture(USER, 'buy milk, eggs and bread');
    await service.capture(USER, 'idea: an app that turns voice notes into recipes');
    await service.capture(USER, 'Meeting with Priya: agreed to ship the beta by 15 Feb');
    const hits = await service.search(USER, 'what did Priya agree on the beta');
    expect(hits[0]!.note.type).toBe('meeting');
    const none = await service.search(USER, 'quantum chromodynamics');
    expect(none).toEqual([]);
  });

  it('finds by stemmed keyword overlap (groceries ~ grocery)', async () => {
    const { service } = makeApp();
    await service.capture(USER, 'Grocery list: milk, eggs');
    expect((await service.search(USER, 'groceries'))[0]?.note.type).toBe('shopping');
  });

  it('excludes deleted notes and other users', async () => {
    const { service } = makeApp();
    const a = await service.capture(USER, 'buy milk');
    await service.capture('someone-else', 'buy milk too');
    await service.remove(USER, a.id);
    expect(await service.search(USER, 'milk')).toEqual([]);
  });

  it('still returns keyword hits for notes with no embedding', async () => {
    const { service, store } = makeApp();
    const n = await service.capture(USER, 'passport renewal documents');
    await store.setEmbedding(n.id, 'other-model', [1, 0]); // simulate provider switch
    expect((await service.search(USER, 'passport'))[0]?.note.id).toBe(n.id);
    expect(await service.reindex(USER)).toMatchObject({ done: 1, remaining: 0 });
  });
});

describe('NotesService mutations', () => {
  it('done / reopen / delete / restore / refile', async () => {
    const { service } = makeApp();
    const n = await service.capture(USER, 'call bank tomorrow');
    expect((await service.markDone(USER, n.id))?.status).toBe('done');
    expect((await service.reopen(USER, n.id))?.status).toBe('open');
    expect((await service.remove(USER, n.id))?.status).toBe('deleted');
    expect((await service.restore(USER, n.id))?.status).toBe('open');
    expect((await service.refile(USER, n.id, 'idea'))?.type).toBe('idea');
  });

  it("cannot touch another user's notes", async () => {
    const { service } = makeApp();
    const n = await service.capture(USER, 'secret');
    expect(await service.markDone('intruder', n.id)).toBeNull();
    expect((await service.get(USER, n.id))?.status).toBe('open');
  });

  it('snooze moves the due time and re-arms the reminder', async () => {
    const { service } = makeApp();
    const n = await service.capture(USER, 'call mom at 6pm');
    await service.markReminded(USER, n.id);
    const s = await service.snooze(USER, n.id, '1h');
    expect(s).toMatchObject({ dueAt: '2025-03-12T15:00:00.000Z', dueHasTime: true, remindedAt: null });
    expect((await service.snooze(USER, n.id, 'tomorrow'))?.dueAt).toBe('2025-03-13T13:00:00.000Z'); // 09:00 EDT
  });

  it('toggles checklist items', async () => {
    const { service } = makeApp();
    const n = await service.capture(USER, 'buy milk, eggs');
    const t = await service.toggleItem(USER, n.id, 1);
    expect(t!.items.map((i) => i.done)).toEqual([false, true]);
  });
});

describe('listing', () => {
  it('orders tasks by due date with undated last, and hides done/deleted', async () => {
    const { service } = makeApp();
    await service.capture(USER, 'todo: undated chore');
    await service.capture(USER, 'call bank on friday');
    await service.capture(USER, 'call dentist tomorrow');
    const done = await service.capture(USER, 'call plumber today');
    await service.markDone(USER, done.id);
    const titles = (await service.tasks(USER)).map((n) => n.title);
    expect(titles).toEqual(['Call dentist tomorrow', 'Call bank on friday', 'Undated chore']);
  });

  it('digestData buckets overdue / today / upcoming', async () => {
    const { service, store, clock } = makeApp();
    const mk = async (text: string) => service.capture(USER, text);
    await mk('call A today');
    await mk('call B tomorrow');
    await mk('call C in 3 days');
    await mk('call D in 10 days');
    await mk('todo: E no date');
    const early = await mk('call F today');
    await store.update(USER, early.id, { dueAt: '2025-03-10T14:00:00.000Z', dueHasTime: true }); // two days ago
    const d = await service.digestData(USER);
    expect(d.overdue.map((n) => n.title)).toEqual(['Call F today']);
    expect(d.dueToday.map((n) => n.title)).toEqual(['Call A today']);
    expect(d.upcoming.map((n) => n.title)).toEqual(['Call B tomorrow', 'Call C in 3 days']);
    expect(d.undatedTasks.map((n) => n.title)).toEqual(['E no date']);
    expect(d.openTaskCount).toBe(6);
    expect(clock.now.zoneName).toBe(ZONE);
    expect(NOW.hour).toBe(10);
  });
});

describe('search thresholds (calibrated embedder profile)', () => {
  // Deterministic 2-d "embeddings": the text decides the angle, so cosine scores are predictable.
  const angles: Record<string, number> = { ramen: 0, dentist: 70, passport: 75, flights: 80 };
  const vec = (text: string) => {
    const key = Object.keys(angles).find((k) => text.toLowerCase().includes(k));
    const a = ((key ? angles[key]! : 90) * Math.PI) / 180;
    return [Math.cos(a), Math.sin(a)];
  };
  const embedder = {
    model: 'fake-2d',
    isMock: false,
    search: { minScore: 0.5, margin: 0.1, minLift: 0.05 },
    async embed(texts: string[]) {
      // The query is "ramen-like" (angle 0) unless it mentions another key.
      return texts.map((t) => (t.startsWith('Q:') ? vec(t.slice(2) || 'ramen') : vec(t)));
    },
  };

  async function build() {
    const { service, store, classifier } = makeApp();
    const { NotesService } = await import('../src/core/service.js');
    const svc = new NotesService({ store, classifier, embedder, timezone: ZONE, now: () => NOW });
    for (const t of ['ramen place on 5th', 'dentist appointment', 'passport renewal', 'flights to Berlin']) await svc.capture(USER, t);
    return { svc, service };
  }

  it('returns only hits above the noise floor and near the best score', async () => {
    const { svc } = await build();
    const hits = await svc.search(USER, 'Q:ramen');
    expect(hits.map((h) => h.note.title)).toEqual(['Ramen place on 5th']);
  });

  it('returns nothing when no single note stands out (all similarly close)', async () => {
    const { svc } = await build();
    expect(await svc.search(USER, 'Q:zzz')).toEqual([]);
  });
});
