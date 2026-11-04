import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Note, NoteItem, NoteStatus, NoteType } from '../types.js';
import { bufferToVector, vectorToBuffer } from '../llm/vector.js';
import type { EmbeddedNote, ListQuery, NewNote, NotePatch, NoteStore } from './store.js';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    due_at TEXT,
    due_has_time INTEGER NOT NULL DEFAULT 0,
    reminded_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    processed_by TEXT NOT NULL DEFAULT 'heuristic',
    embedding BLOB,
    embedding_model TEXT,
    import_hash TEXT
  );
  CREATE INDEX idx_notes_user_type ON notes(user_id, type, status);
  CREATE INDEX idx_notes_user_created ON notes(user_id, created_at);
  CREATE INDEX idx_notes_due ON notes(due_at) WHERE due_at IS NOT NULL;
  CREATE UNIQUE INDEX idx_notes_import ON notes(user_id, import_hash) WHERE import_hash IS NOT NULL;
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

interface Row {
  id: number;
  user_id: string;
  created_at: string;
  updated_at: string;
  raw_text: string;
  source: string;
  type: string;
  title: string;
  context: string;
  tags: string;
  items: string;
  due_at: string | null;
  due_has_time: number;
  reminded_at: string | null;
  status: string;
  processed_by: string;
  embedding_model: string | null;
  import_hash: string | null;
  embedding?: Buffer | null;
}

const COLS =
  'id, user_id, created_at, updated_at, raw_text, source, type, title, context, tags, items, due_at, due_has_time, reminded_at, status, processed_by, embedding_model, import_hash';

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toNote(r: Row): Note {
  return {
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    rawText: r.raw_text,
    source: r.source,
    type: r.type as NoteType,
    title: r.title,
    context: r.context,
    tags: safeJson<string[]>(r.tags, []),
    items: safeJson<NoteItem[]>(r.items, []),
    dueAt: r.due_at,
    dueHasTime: r.due_has_time === 1,
    remindedAt: r.reminded_at,
    status: r.status as NoteStatus,
    processedBy: r.processed_by,
    embeddingModel: r.embedding_model,
    importHash: r.import_hash,
  };
}

export class SqliteStore implements NoteStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  async insert(n: NewNote): Promise<Note> {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO notes (user_id, created_at, updated_at, raw_text, source, type, title, context, tags, items, due_at, due_has_time, status, processed_by, import_hash)
         VALUES (@user_id, @created_at, @updated_at, @raw_text, @source, @type, @title, @context, @tags, @items, @due_at, @due_has_time, @status, @processed_by, @import_hash)`,
      )
      .run({
        user_id: n.userId,
        created_at: n.createdAt ?? now,
        updated_at: now,
        raw_text: n.rawText,
        source: n.source,
        type: n.type,
        title: n.title,
        context: n.context,
        tags: JSON.stringify(n.tags),
        items: JSON.stringify(n.items),
        due_at: n.dueAt,
        due_has_time: n.dueHasTime ? 1 : 0,
        status: n.status ?? 'open',
        processed_by: n.processedBy,
        import_hash: n.importHash ?? null,
      });
    const note = await this.get(n.userId, Number(info.lastInsertRowid));
    return note!;
  }

  async get(userId: string, id: number): Promise<Note | null> {
    const r = this.db.prepare(`SELECT ${COLS} FROM notes WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined;
    return r ? toNote(r) : null;
  }

  async update(userId: string, id: number, patch: NotePatch): Promise<Note | null> {
    const sets: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, user_id: userId, updated_at: new Date().toISOString() };
    const map: Record<string, string> = {
      type: 'type',
      title: 'title',
      context: 'context',
      dueAt: 'due_at',
      remindedAt: 'reminded_at',
      status: 'status',
      processedBy: 'processed_by',
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = @${col}`);
        params[col] = (patch as Record<string, unknown>)[k] ?? null;
      }
    }
    if (patch.tags) {
      sets.push('tags = @tags');
      params.tags = JSON.stringify(patch.tags);
    }
    if (patch.items) {
      sets.push('items = @items');
      params.items = JSON.stringify(patch.items);
    }
    if (patch.dueHasTime !== undefined) {
      sets.push('due_has_time = @due_has_time');
      params.due_has_time = patch.dueHasTime ? 1 : 0;
    }
    this.db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = @id AND user_id = @user_id`).run(params);
    return this.get(userId, id);
  }

  async list(q: ListQuery): Promise<Note[]> {
    const where = ['user_id = @user_id'];
    const params: Record<string, unknown> = { user_id: q.userId, limit: q.limit ?? 20 };
    const statuses = q.status === undefined ? ['open', 'done'] : Array.isArray(q.status) ? q.status : [q.status];
    where.push(`status IN (${statuses.map((_, i) => `@s${i}`).join(',')})`);
    statuses.forEach((s, i) => (params[`s${i}`] = s));
    if (q.types?.length) {
      where.push(`type IN (${q.types.map((_, i) => `@t${i}`).join(',')})`);
      q.types.forEach((t, i) => (params[`t${i}`] = t));
    }
    const order = q.orderByDue ? 'due_at IS NULL, due_at ASC, created_at DESC' : 'created_at DESC, id DESC';
    const rows = this.db.prepare(`SELECT ${COLS} FROM notes WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT @limit`).all(params) as Row[];
    return rows.map(toNote);
  }

  async dueBetween(userId: string, startIso: string, endIso: string): Promise<Note[]> {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM notes WHERE user_id = ? AND status = 'open' AND due_at >= ? AND due_at < ? ORDER BY due_at ASC`)
      .all(userId, startIso, endIso) as Row[];
    return rows.map(toNote);
  }

  async dueReminders(nowIso: string): Promise<Note[]> {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM notes WHERE status = 'open' AND due_has_time = 1 AND due_at <= ? AND reminded_at IS NULL ORDER BY due_at ASC LIMIT 50`)
      .all(nowIso) as Row[];
    return rows.map(toNote);
  }

  async setEmbedding(id: number, model: string, vector: number[]): Promise<void> {
    this.db.prepare('UPDATE notes SET embedding = ?, embedding_model = ? WHERE id = ?').run(vectorToBuffer(vector), model, id);
  }

  async withEmbeddings(userId: string, model: string): Promise<EmbeddedNote[]> {
    const rows = this.db
      .prepare(`SELECT ${COLS}, embedding FROM notes WHERE user_id = ? AND status != 'deleted' AND embedding_model = ? AND embedding IS NOT NULL`)
      .all(userId, model) as Row[];
    return rows.map((r) => ({ note: toNote(r), vector: bufferToVector(r.embedding as Buffer) }));
  }

  async missingEmbeddings(userId: string, model: string, limit: number): Promise<Note[]> {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM notes WHERE user_id = ? AND status != 'deleted' AND (embedding IS NULL OR embedding_model IS NOT ?) ORDER BY id DESC LIMIT ?`)
      .all(userId, model, limit) as Row[];
    return rows.map(toNote);
  }

  async heuristicProcessed(userId: string, limit: number): Promise<Note[]> {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM notes WHERE user_id = ? AND status != 'deleted' AND processed_by = 'heuristic' ORDER BY id DESC LIMIT ?`)
      .all(userId, limit) as Row[];
    return rows.map(toNote);
  }

  async hasImportHash(userId: string, hash: string): Promise<boolean> {
    return !!this.db.prepare('SELECT 1 FROM notes WHERE user_id = ? AND import_hash = ?').get(userId, hash);
  }

  async all(userId: string): Promise<Note[]> {
    const rows = this.db.prepare(`SELECT ${COLS} FROM notes WHERE user_id = ? ORDER BY id ASC`).all(userId) as Row[];
    return rows.map(toNote);
  }

  async counts(userId: string): Promise<Record<string, number>> {
    const rows = this.db
      .prepare(`SELECT type, COUNT(*) AS n FROM notes WHERE user_id = ? AND status = 'open' GROUP BY type`)
      .all(userId) as { type: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  async getMeta(key: string): Promise<string | null> {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
