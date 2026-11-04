export const NOTE_TYPES = ['task', 'shopping', 'meeting', 'idea', 'reference', 'journal', 'other'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export type NoteStatus = 'open' | 'done' | 'deleted';

export const TYPE_EMOJI: Record<NoteType, string> = {
  task: '✅',
  shopping: '🛒',
  meeting: '🗣️',
  idea: '💡',
  reference: '🔗',
  journal: '📓',
  other: '📝',
};

export interface NoteItem {
  text: string;
  done: boolean;
}

export interface Note {
  id: number;
  userId: string;
  createdAt: string; // ISO UTC
  updatedAt: string;
  rawText: string;
  source: string; // telegram | voice | whatsapp | cli
  type: NoteType;
  title: string;
  context: string; // one-line "why I saved this"
  tags: string[];
  items: NoteItem[];
  dueAt: string | null; // ISO UTC
  dueHasTime: boolean;
  remindedAt: string | null;
  status: NoteStatus;
  processedBy: string; // gemini | groq | mock | heuristic
  embeddingModel: string | null;
  importHash: string | null;
}

/** Output of the AI (or heuristic) classifier, after validation/normalisation. */
export interface Classification {
  type: NoteType;
  title: string;
  tags: string[];
  items: string[];
  /** Local date `YYYY-MM-DD` or local date-time `YYYY-MM-DDTHH:mm` in the user's timezone. */
  due: string | null;
  context: string;
}
