import { fetchWithRetry, parseModelList, withModelFallback, type FetchLike, type RetryOptions } from './http.js';
import { ProviderError, type JsonRequest, type LLMProvider, type TranscriptionProvider } from './types.js';

const BASE = 'https://api.groq.com/openai/v1';

export interface GroqOptions {
  apiKey: string;
  /** One model id or a comma-separated fallback list, tried in order. */
  model: string;
  whisperModel: string;
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
}

export class GroqLLM implements LLMProvider {
  readonly name = 'groq';
  readonly isMock = false;
  constructor(private readonly o: GroqOptions) {}

  async generateJson(req: JsonRequest): Promise<string> {
    return withModelFallback(
      parseModelList(this.o.model),
      async (model, retry) => {
        const res = await fetchWithRetry(
          this.o.fetchImpl ?? fetch,
          `${BASE}/chat/completions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.user },
              ],
            }),
          },
          retry,
        );
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new ProviderError(`Groq (${model}) returned no text`);
        return text;
      },
      this.o.retry,
    );
  }
}

/** Groq-hosted Whisper (free tier). */
export class GroqWhisper implements TranscriptionProvider {
  readonly name = 'groq-whisper';
  constructor(private readonly o: GroqOptions) {}

  async transcribe(audio: Uint8Array, filename: string, mimeType = 'audio/ogg'): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([audio as unknown as ArrayBuffer], { type: mimeType }), filename);
    form.append('model', this.o.whisperModel);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await fetchWithRetry(
      this.o.fetchImpl ?? fetch,
      `${BASE}/audio/transcriptions`,
      { method: 'POST', headers: { authorization: `Bearer ${this.o.apiKey}` }, body: form },
      { timeoutMs: 60_000, ...this.o.retry },
    );
    const data = (await res.json()) as { text?: string };
    if (typeof data.text !== 'string') throw new ProviderError('Whisper returned no text');
    return data.text.trim();
  }
}
