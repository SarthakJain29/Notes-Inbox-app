import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { parseCapture } from '../ai/capture.js';
import type { Classifier, ClassifyResult } from '../ai/classifier.js';
import { tokenize } from '../llm/mock.js';
import type { EmbeddingProvider } from '../llm/types.js';
import { cosine } from '../llm/vector.js';
import type { NoteStore } from '../db/store.js';
import type { Note, NoteItem, NoteType } from '../types.js';
import { dayBounds, parseLocalDue } from '../util/time.js';

export interface ServiceDeps {
  store: NoteStore;
  classifier: Classifier;
  embedder: EmbeddingProvider;
  timezone: string;
  /** Injectable clock for tests. */
  now?: () => DateTime;
  log?: (m: string) => void;
}

export interface CaptureOptions {
  source?: string;
  /** Original timestamp (ISO) for imported notes. */
  createdAt?: string;
}

export interface SearchHit {
  note: Note;
  score: number;
}

/** Text that represents a note in the embedding space. */
export function embeddingText(n: Pick<Note, 'title' | 'type' | 'tags' | 'context' | 'items' | 'rawText'>): string {
  return [n.title, `type: ${n.type}`, n.tags.length ? `tags: ${n.tags.join(', ')}` : '', n.context, n.items.map((i) => i.text).join(', '), n.rawText]
    .filter(Boolean)
    .join('\n');
}

export function importHash(timestampIso: string, text: string): string {
  return createHash('sha1').update(`${timestampIso}\n${text}`).digest('hex');
}

export class NotesService {
  readonly timezone: string;
  private readonly store: NoteStore;
  private readonly classifier: Classifier;
  private readonly embedder: EmbeddingProvider;
  private readonly clock: () => DateTime;
  private readonly log: (m: string) => void;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.classifier = deps.classifier;
    this.embedder = deps.embedder;
    this.timezone = deps.timezone;
    this.log = deps.log ?? (() => {});
    this.clock = deps.now ?? (() => DateTime.now().setZone(deps.timezone));
  }

  now(): DateTime {
    return this.clock().setZone(this.timezone);
  }

  get storeRef(): NoteStore {
    return this.store;
  }

  // ---------- capture ----------

  async capture(userId: string, text: string, opts: CaptureOptions = {}): Promise<Note> {
    const parsed = parseCapture(text);
    const content = parsed.content || text.trim();
    const result = await this.classifier.classify(
      { content, userTitle: parsed.title, typeHint: parsed.typeHint, userTags: parsed.tags },
      this.now(),
    );
    return this.persist(userId, text, result, opts);
  }

  /** Store an already-classified note and embed it (embedding failures never lose the note). */
  async persist(userId: string, rawText: string, c: ClassifyResult, opts: CaptureOptions & { importHash?: string; status?: 'open' | 'done' } = {}): Promise<Note> {
    const due = parseLocalDue(c.due, this.timezone);
    const items: NoteItem[] = c.items.map((text) => ({ text, done: false }));
    const note = await this.store.insert({
      userId,
      createdAt: opts.createdAt,
      rawText,
      source: opts.source ?? 'telegram',
      type: c.type,
      title: c.title,
      context: c.context,
      tags: c.tags,
      items,
      dueAt: due?.iso ?? null,
      dueHasTime: due?.hasTime ?? false,
      status: opts.status,
      processedBy: c.processedBy,
      importHash: opts.importHash ?? null,
    });
    await this.embedNote(note);
    return note;
  }

  private async embedNote(note: Note): Promise<void> {
    try {
      const [v] = await this.embedder.embed([embeddingText(note)], 'document');
      if (v) await this.store.setEmbedding(note.id, this.embedder.model, v);
    } catch (err) {
      this.log(`embedding failed for #${note.id}: ${(err as Error).message}`);
    }
  }

  /** Embed notes that are missing a vector for the current embedding model. Returns how many were done. */
  async reindex(userId: string, limit = 200): Promise<{ done: number; remaining: number }> {
    const missing = await this.store.missingEmbeddings(userId, this.embedder.model, limit);
    if (!missing.length) return { done: 0, remaining: 0 };
    let done = 0;
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      try {
        const vecs = await this.embedder.embed(chunk.map(embeddingText), 'document');
        for (let j = 0; j < chunk.length; j++) {
          await this.store.setEmbedding(chunk[j]!.id, this.embedder.model, vecs[j]!);
          done++;
        }
      } catch (err) {
        this.log(`reindex chunk failed: ${(err as Error).message}`);
        break;
      }
    }
    const remaining = (await this.store.missingEmbeddings(userId, this.embedder.model, 1)).length;
    return { done, remaining };
  }

  /** Re-run classification for notes that only got the offline heuristic (e.g. the LLM was down). */
  async reprocess(userId: string, limit = 20): Promise<{ improved: number; tried: number }> {
    const notes = await this.store.heuristicProcessed(userId, limit);
    let improved = 0;
    for (const n of notes) {
      const parsed = parseCapture(n.rawText);
      const res = await this.classifier.classify(
        { content: parsed.content || n.rawText, userTitle: parsed.title, typeHint: parsed.typeHint, userTags: parsed.tags },
        this.now(),
      );
      if (res.processedBy === 'heuristic') continue;
      const due = parseLocalDue(res.due, this.timezone);
      const updated = await this.store.update(userId, n.id, {
        type: res.type,
        title: res.title,
        context: res.context,
        tags: res.tags,
        items: res.items.map((text) => ({ text, done: false })),
        dueAt: due?.iso ?? n.dueAt,
        dueHasTime: due ? due.hasTime : n.dueHasTime,
        processedBy: res.processedBy,
      });
      if (updated) await this.embedNote(updated);
      improved++;
    }
    return { improved, tried: notes.length };
  }

  // ---------- retrieval ----------

  tasks(userId: string, limit = 30): Promise<Note[]> {
    return this.store.list({ userId, types: ['task'], status: 'open', limit, orderByDue: true });
  }

  byType(userId: string, type: NoteType, limit = 20): Promise<Note[]> {
    return this.store.list({ userId, types: [type], status: 'open', limit });
  }

  recent(userId: string, limit = 10): Promise<Note[]> {
    return this.store.list({ userId, status: ['open', 'done'], limit });
  }

  get(userId: string, id: number): Promise<Note | null> {
    return this.store.get(userId, id);
  }

  async search(userId: string, query: string, k = 5): Promise<SearchHit[]> {
    const qTokens = [...new Set(tokenize(query))];
    const all = (await this.store.all(userId)).filter((n) => n.status !== 'deleted');
    const vectors = new Map<number, Float32Array>();
    let qv: number[] | null = null;
    try {
      [qv = null] = await this.embedder.embed([query], 'query');
      for (const e of await this.store.withEmbeddings(userId, this.embedder.model)) vectors.set(e.note.id, e.vector);
    } catch (err) {
      this.log(`query embedding failed, keyword search only: ${(err as Error).message}`);
    }

    const scored: SearchHit[] = [];
    for (const note of all) {
      const hay = new Set(tokenize(embeddingText(note)));
      const kw = qTokens.length ? qTokens.filter((t) => hay.has(t)).length / qTokens.length : 0;
      const vec = vectors.get(note.id);
      const cos = qv && vec ? cosine(qv, vec) : 0;
      const score = cos + 0.3 * kw;
      const minCos = this.embedder.isMock ? 0.12 : 0.5;
      if (kw > 0 || cos >= minCos) scored.push({ note, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    return scored.filter((h) => h.score >= best - 0.2).slice(0, k);
  }

  // ---------- mutations ----------

  async markDone(userId: string, id: number): Promise<Note | null> {
    return this.store.update(userId, id, { status: 'done' });
  }

  async reopen(userId: string, id: number): Promise<Note | null> {
    return this.store.update(userId, id, { status: 'open', remindedAt: null });
  }

  async remove(userId: string, id: number): Promise<Note | null> {
    return this.store.update(userId, id, { status: 'deleted' });
  }

  async restore(userId: string, id: number): Promise<Note | null> {
    return this.store.update(userId, id, { status: 'open' });
  }

  async refile(userId: string, id: number, type: NoteType): Promise<Note | null> {
    const updated = await this.store.update(userId, id, { type });
    if (updated) await this.embedNote(updated);
    return updated;
  }

  /** Move the due time of a note (used by reminder "snooze" buttons). */
  async snooze(userId: string, id: number, kind: '1h' | 'tomorrow'): Promise<Note | null> {
    const now = this.now();
    const target = kind === '1h' ? now.plus({ hours: 1 }) : now.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    return this.store.update(userId, id, { dueAt: target.toUTC().toISO()!, dueHasTime: true, remindedAt: null });
  }

  async markReminded(userId: string, id: number): Promise<void> {
    await this.store.update(userId, id, { remindedAt: new Date().toISOString() });
  }

  async toggleItem(userId: string, id: number, index: number): Promise<Note | null> {
    const n = await this.store.get(userId, id);
    if (!n || !n.items[index]) return n;
    const items = n.items.map((it, i) => (i === index ? { ...it, done: !it.done } : it));
    return this.store.update(userId, id, { items });
  }

  // ---------- digest ----------

  async digestData(userId: string): Promise<DigestData> {
    const now = this.now();
    const today = dayBounds(now, 0);
    const soon = dayBounds(now, 4);
    const [overdue, dueToday, upcoming, undated] = await Promise.all([
      this.store.dueBetween(userId, '0000-01-01T00:00:00.000Z', today.start),
      this.store.dueBetween(userId, today.start, today.end),
      this.store.dueBetween(userId, today.end, soon.start),
      this.tasks(userId, 100),
    ]);
    const openTasks = undated;
    return {
      overdue: overdue.filter((n) => n.type !== 'shopping'),
      dueToday: dueToday.filter((n) => n.type !== 'shopping'),
      upcoming: upcoming.filter((n) => n.type !== 'shopping'),
      undatedTasks: openTasks.filter((n) => !n.dueAt),
      openTaskCount: openTasks.length,
      shopping: await this.byType(userId, 'shopping', 10),
    };
  }
}

export interface DigestData {
  overdue: Note[];
  dueToday: Note[];
  upcoming: Note[];
  undatedTasks: Note[];
  openTaskCount: number;
  shopping: Note[];
}
