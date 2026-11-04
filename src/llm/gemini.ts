import { fetchWithRetry, parseModelList, withModelFallback, type FetchLike, type RetryOptions } from './http.js';
import { ProviderError, type EmbedKind, type EmbeddingProvider, type JsonRequest, type LLMProvider } from './types.js';
import { l2normalize } from './vector.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiOptions {
  apiKey: string;
  /** One model id or a comma-separated fallback list, tried in order. */
  model: string;
  embeddingModel: string;
  /** Output dimensionality for embeddings (Matryoshka). 768 keeps storage small. */
  embeddingDims?: number;
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
}

export class GeminiLLM implements LLMProvider {
  readonly name = 'gemini';
  readonly isMock = false;
  constructor(private readonly o: GeminiOptions) {}

  async generateJson(req: JsonRequest): Promise<string> {
    return withModelFallback(
      parseModelList(this.o.model),
      async (model, retry) => {
        const res = await fetchWithRetry(
          this.o.fetchImpl ?? fetch,
          `${BASE}/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: req.system }] },
              contents: [{ role: 'user', parts: [{ text: req.user }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
            }),
          },
          retry,
        );
        const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
        if (!text) throw new ProviderError(`Gemini (${model}) returned no text`);
        return text;
      },
      this.o.retry,
    );
  }
}

export class GeminiEmbedder implements EmbeddingProvider {
  readonly isMock = false;
  // Calibrated on gemini-embedding-001 (768d): relevant ≈ 0.68–0.75, unrelated noise ≈ 0.48–0.61.
  readonly search = { minScore: 0.55, margin: 0.04, minLift: 0.04 };
  readonly model: string;
  private readonly dims: number;
  constructor(private readonly o: GeminiOptions) {
    this.dims = o.embeddingDims ?? 768;
    this.model = `gemini:${o.embeddingModel}:${this.dims}`;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return [];
    const taskType = kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const out: number[][] = [];
    // batchEmbedContents accepts up to 100 requests per call.
    for (let i = 0; i < texts.length; i += 100) {
      const chunk = texts.slice(i, i + 100);
      const res = await fetchWithRetry(
        this.o.fetchImpl ?? fetch,
        `${BASE}/models/${this.o.embeddingModel}:batchEmbedContents`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
          body: JSON.stringify({
            requests: chunk.map((t) => ({
              model: `models/${this.o.embeddingModel}`,
              content: { parts: [{ text: t.slice(0, 8000) }] },
              taskType,
              outputDimensionality: this.dims,
            })),
          }),
        },
        this.o.retry,
      );
      const data = (await res.json()) as { embeddings?: { values?: number[] }[] };
      if (!data.embeddings || data.embeddings.length !== chunk.length) {
        throw new ProviderError('Gemini returned an unexpected number of embeddings');
      }
      for (const e of data.embeddings) {
        if (!e.values?.length) throw new ProviderError('Gemini returned an empty embedding');
        out.push(l2normalize(e.values));
      }
    }
    return out;
  }
}
