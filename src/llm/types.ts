/**
 * Small provider abstraction. The rest of the app only talks to these interfaces,
 * so adding a new vendor (or swapping the free tier for a paid one) is one file.
 */
export interface JsonRequest {
  system: string;
  user: string;
}

export interface LLMProvider {
  /** Stable id stored with each note (e.g. "gemini"). */
  readonly name: string;
  /** True when no real model is behind it; callers should use heuristics instead. */
  readonly isMock: boolean;
  /** Ask the model for a JSON document. Returns the raw text (parsing/validation is the caller's job). */
  generateJson(req: JsonRequest): Promise<string>;
}

export type EmbedKind = 'document' | 'query';

export interface SearchProfile {
  /** Cosine similarity below which a note is considered unrelated (the model's noise floor). */
  minScore: number;
  /** Keep only hits within this distance of the best one. */
  margin: number;
  /** The best hit must beat the median similarity by this much, otherwise nothing really stands out. */
  minLift: number;
}

export interface EmbeddingProvider {
  /** Identifies the vector space. Vectors are only comparable when this matches. */
  readonly model: string;
  readonly isMock: boolean;
  /** Calibrated per model; see developer.md "Search tuning". */
  readonly search: SearchProfile;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: Uint8Array, filename: string, mimeType?: string): Promise<string>;
}

export interface AIServices {
  llm: LLMProvider;
  embedder: EmbeddingProvider;
  /** null when no transcription backend is configured. */
  transcriber: TranscriptionProvider | null;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
