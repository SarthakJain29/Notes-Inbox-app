import type { Note, NoteItem, NoteStatus, NoteType } from '../types.js';

export interface NewNote {
  userId: string;
  createdAt?: string;
  rawText: string;
  source: string;
  type: NoteType;
  title: string;
  context: string;
  tags: string[];
  items: NoteItem[];
  dueAt: string | null;
  dueHasTime: boolean;
  status?: NoteStatus;
  processedBy: string;
  importHash?: string | null;
}

export type NotePatch = Partial<
  Pick<Note, 'type' | 'title' | 'context' | 'tags' | 'items' | 'dueAt' | 'dueHasTime' | 'remindedAt' | 'status' | 'processedBy'>
>;

export interface ListQuery {
  userId: string;
  types?: NoteType[];
  status?: NoteStatus | NoteStatus[];
  limit?: number;
  /** Order by due date (nulls last) then newest, instead of newest first. */
  orderByDue?: boolean;
}

export interface EmbeddedNote {
  note: Note;
  vector: Float32Array;
}

/**
 * Persistence boundary. Everything is async and scoped by userId so a Postgres/libSQL
 * implementation (and multiple users) can be dropped in later without touching callers.
 */
export interface NoteStore {
  insert(n: NewNote): Promise<Note>;
  get(userId: string, id: number): Promise<Note | null>;
  update(userId: string, id: number, patch: NotePatch): Promise<Note | null>;
  list(q: ListQuery): Promise<Note[]>;
  /** Open notes with a due date in [startIso, endIso). */
  dueBetween(userId: string, startIso: string, endIso: string): Promise<Note[]>;
  /** Open notes with a timed due date <= nowIso that have not been reminded yet. */
  dueReminders(nowIso: string): Promise<Note[]>;
  setEmbedding(id: number, model: string, vector: number[]): Promise<void>;
  /** Non-deleted notes that have an embedding made with `model`. */
  withEmbeddings(userId: string, model: string): Promise<EmbeddedNote[]>;
  /** Non-deleted notes lacking an embedding for `model` (e.g. after switching providers). */
  missingEmbeddings(userId: string, model: string, limit: number): Promise<Note[]>;
  /** Non-deleted notes processed by the offline heuristic (candidates for re-classification). */
  heuristicProcessed(userId: string, limit: number): Promise<Note[]>;
  hasImportHash(userId: string, hash: string): Promise<boolean>;
  all(userId: string): Promise<Note[]>;
  counts(userId: string): Promise<Record<string, number>>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  close(): void;
}
