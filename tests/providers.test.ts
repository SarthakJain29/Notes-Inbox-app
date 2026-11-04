import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { GeminiEmbedder, GeminiLLM } from '../src/llm/gemini.js';
import { GroqLLM, GroqWhisper } from '../src/llm/groq.js';
import { fetchWithRetry, withModelFallback } from '../src/llm/http.js';
import { createAIServices } from '../src/llm/index.js';
import { HashEmbedder } from '../src/llm/mock.js';
import { ProviderError } from '../src/llm/types.js';
import { cosine, l2normalize } from '../src/llm/vector.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = { sleep: async () => {}, baseDelayMs: 0 };

describe('GeminiLLM', () => {
  it('sends the right request and extracts text', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const llm = new GeminiLLM({
      apiKey: 'K',
      model: 'm1',
      embeddingModel: 'e',
      fetchImpl: async (url, init) => (seen.push({ url: String(url), init: init! }), json({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] })),
    });
    expect(await llm.generateJson({ system: 'SYS', user: 'USR' })).toBe('{"a":1}');
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent');
    expect((seen[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('K');
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('SYS');
    expect(body.contents[0].parts[0].text).toBe('USR');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('falls back to the next model on overload / retired model', async () => {
    const tried: string[] = [];
    const llm = new GeminiLLM({
      apiKey: 'K',
      model: 'big, retired ,small',
      embeddingModel: 'e',
      retry: noSleep,
      fetchImpl: async (url) => {
        const m = /models\/([^:]+):/.exec(String(url))![1]!;
        tried.push(m);
        if (m === 'big') return json({ error: 'overloaded' }, 503);
        if (m === 'retired') return json({ error: 'gone' }, 404);
        return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
      },
    });
    expect(await llm.generateJson({ system: '', user: '' })).toBe('ok');
    expect(tried).toEqual(['big', 'big', 'retired', 'small']); // 503 retried once, 404 not retried
  });

  it('aborts immediately on auth errors', async () => {
    let calls = 0;
    const llm = new GeminiLLM({ apiKey: 'bad', model: 'a,b', embeddingModel: 'e', retry: noSleep, fetchImpl: async () => (calls++, json({ error: 'nope' }, 403)) });
    await expect(llm.generateJson({ system: '', user: '' })).rejects.toThrow(/403/);
    expect(calls).toBe(1);
  });

  it('errors when the response has no text', async () => {
    const llm = new GeminiLLM({ apiKey: 'K', model: 'a', embeddingModel: 'e', retry: noSleep, fetchImpl: async () => json({ candidates: [] }) });
    await expect(llm.generateJson({ system: '', user: '' })).rejects.toThrow(/no text/);
  });
});

describe('GeminiEmbedder', () => {
  it('batches, sets task type and normalises', async () => {
    let body: any;
    const e = new GeminiEmbedder({
      apiKey: 'K',
      model: 'x',
      embeddingModel: 'gemini-embedding-001',
      embeddingDims: 3,
      fetchImpl: async (_u, init) => ((body = JSON.parse(init!.body as string)), json({ embeddings: [{ values: [3, 4, 0] }, { values: [0, 0, 2] }] })),
    });
    expect(e.model).toBe('gemini:gemini-embedding-001:3');
    const v = await e.embed(['a', 'b'], 'query');
    expect(body.requests[0]).toMatchObject({ model: 'models/gemini-embedding-001', taskType: 'RETRIEVAL_QUERY', outputDimensionality: 3 });
    expect(v[0]).toEqual([0.6, 0.8, 0]);
    expect(v[1]).toEqual([0, 0, 1]);
  });
  it('rejects mismatched counts', async () => {
    const e = new GeminiEmbedder({ apiKey: 'K', model: 'x', embeddingModel: 'e', retry: noSleep, fetchImpl: async () => json({ embeddings: [] }) });
    await expect(e.embed(['a'], 'document')).rejects.toThrow(/unexpected number/);
  });
});

describe('Groq', () => {
  it('chat completion uses JSON mode and bearer auth', async () => {
    let init: RequestInit | undefined;
    const llm = new GroqLLM({ apiKey: 'G', model: 'm', whisperModel: 'w', fetchImpl: async (_u, i) => ((init = i), json({ choices: [{ message: { content: '{"ok":1}' } }] })) });
    expect(await llm.generateJson({ system: 's', user: 'u' })).toBe('{"ok":1}');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer G');
    const body = JSON.parse(init!.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
  });

  it('Whisper posts multipart audio and returns trimmed text', async () => {
    let init: RequestInit | undefined;
    let url = '';
    const w = new GroqWhisper({ apiKey: 'G', model: 'm', whisperModel: 'whisper-large-v3-turbo', fetchImpl: async (u, i) => ((url = String(u)), (init = i), json({ text: ' hello world ' })) });
    expect(await w.transcribe(new Uint8Array([1, 2, 3]), 'voice.oga')).toBe('hello world');
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect((form.get('file') as File).name).toBe('voice.oga');
  });
});

describe('fetchWithRetry / withModelFallback', () => {
  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const res = await fetchWithRetry(async () => (++n < 3 ? json({}, 429, { 'retry-after': '2' }) : json({ ok: true })), 'http://x', {}, { sleep: async (ms) => void sleeps.push(ms) });
    expect(res.ok).toBe(true);
    expect(sleeps).toEqual([2000, 2000]);
  });
  it('gives up after the retry budget', async () => {
    let n = 0;
    await expect(fetchWithRetry(async () => (n++, json({}, 500)), 'http://x', {}, { retries: 2, ...noSleep })).rejects.toBeInstanceOf(ProviderError);
    expect(n).toBe(3);
  });
  it('retries network errors', async () => {
    let n = 0;
    const res = await fetchWithRetry(async () => { if (++n < 2) throw new TypeError('fetch failed'); return json({}); }, 'http://x', {}, noSleep);
    expect(res.ok).toBe(true);
  });
  it('does not retry 400s', async () => {
    let n = 0;
    await expect(fetchWithRetry(async () => (n++, json({}, 400)), 'http://x', {}, noSleep)).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
  it('withModelFallback throws the last error when every model fails', async () => {
    await expect(withModelFallback(['a', 'b'], async (m) => { throw new Error(`fail ${m}`); })).rejects.toThrow('fail b');
  });
});

describe('provider selection', () => {
  const log = () => {};
  const cfg = (env: Record<string, string>) => loadConfig(env as NodeJS.ProcessEnv);
  it('is mock without keys', () => {
    const ai = createAIServices(cfg({}), log);
    expect(ai.llm.isMock).toBe(true);
    expect(ai.embedder).toBeInstanceOf(HashEmbedder);
    expect(ai.transcriber).toBeNull();
  });
  it('prefers gemini, then groq', () => {
    expect(createAIServices(cfg({ GEMINI_API_KEY: 'a', GROQ_API_KEY: 'b' }), log).llm.name).toBe('gemini');
    expect(createAIServices(cfg({ GROQ_API_KEY: 'b' }), log).llm.name).toBe('groq');
  });
  it('honours LLM_PROVIDER and degrades to mock when its key is missing', () => {
    expect(createAIServices(cfg({ GEMINI_API_KEY: 'a', GROQ_API_KEY: 'b', LLM_PROVIDER: 'groq' }), log).llm.name).toBe('groq');
    expect(createAIServices(cfg({ GROQ_API_KEY: 'b', LLM_PROVIDER: 'gemini' }), log).llm.isMock).toBe(true);
    expect(createAIServices(cfg({ GEMINI_API_KEY: 'a', LLM_PROVIDER: 'mock' }), log).embedder.isMock).toBe(true);
  });
  it('enables transcription whenever a Groq key exists', () => {
    expect(createAIServices(cfg({ GROQ_API_KEY: 'b', GEMINI_API_KEY: 'a' }), log).transcriber).not.toBeNull();
  });
});

describe('config', () => {
  it('treats empty env values as unset and applies defaults', () => {
    const c = loadConfig({ GEMINI_API_KEY: '', TIMEZONE: '', DIGEST_HOUR: '' } as unknown as NodeJS.ProcessEnv);
    expect(c.GEMINI_API_KEY).toBeUndefined();
    expect(c.TIMEZONE).toBe('UTC');
    expect(c.DIGEST_HOUR).toBe(8);
  });
  it('rejects bad values with a readable message', () => {
    expect(() => loadConfig({ TIMEZONE: 'Mars/Olympus' } as unknown as NodeJS.ProcessEnv)).toThrow(/TIMEZONE/);
    expect(() => loadConfig({ DIGEST_HOUR: '30' } as unknown as NodeJS.ProcessEnv)).toThrow(/DIGEST_HOUR/);
    expect(() => loadConfig({ ALLOWED_TELEGRAM_USER_ID: 'abc' } as unknown as NodeJS.ProcessEnv)).toThrow(/ALLOWED_TELEGRAM_USER_ID/);
  });
});

describe('vectors', () => {
  it('cosine + normalise', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(l2normalize([3, 4])).toEqual([0.6, 0.8]);
  });
});
