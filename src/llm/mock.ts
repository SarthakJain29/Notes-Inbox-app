import type { EmbedKind, EmbeddingProvider, JsonRequest, LLMProvider } from './types.js';
import { ProviderError } from './types.js';
import { l2normalize } from './vector.js';

/** Placeholder LLM used when no API key is configured. Callers detect `isMock` and use heuristics. */
export class MockLLM implements LLMProvider {
  readonly name = 'mock';
  readonly isMock = true;
  async generateJson(_req: JsonRequest): Promise<string> {
    throw new ProviderError('Mock LLM cannot generate; use the heuristic classifier');
  }
}

const STOP = new Set(
  'a an the and or of to in on at for with is are was were be been it this that i my me we you your from by as but if so not no do does did have has had will would can could should'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 3 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const DIMS = 256;

/**
 * Offline "embedding": feature-hashed bag of (stemmed) words + bigrams.
 * Not semantic, but gives sensible keyword-overlap ranking with zero setup, so search works in mock mode.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly model = `mock-hash-${DIMS}`;
  readonly isMock = true;
  async embed(texts: string[], _kind: EmbedKind): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(DIMS).fill(0);
      const toks = tokenize(t);
      for (let i = 0; i < toks.length; i++) {
        v[fnv1a(toks[i]!) % DIMS]! += 1;
        if (i > 0) v[fnv1a(`${toks[i - 1]} ${toks[i]}`) % DIMS]! += 0.5;
      }
      return l2normalize(v);
    });
  }
}
