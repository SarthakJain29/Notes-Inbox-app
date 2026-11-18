import type { Config } from '../config.js';
import { GeminiEmbedder, GeminiLLM } from './gemini.js';
import { GroqLLM, GroqWhisper } from './groq.js';
import { HashEmbedder, MockLLM } from './mock.js';
import type { AIServices } from './types.js';

export type { AIServices, EmbeddingProvider, LLMProvider, TranscriptionProvider } from './types.js';

/**
 * Pick providers from config.
 *  - LLM: gemini > groq > mock (or forced by LLM_PROVIDER)
 *  - Embeddings: Gemini if a key exists (Groq has no embeddings API), else offline hash embeddings
 *  - Transcription: Groq Whisper if a key exists, else none
 * Missing keys never crash the app; they degrade to mock mode.
 */
export function createAIServices(cfg: Config, log: (m: string) => void = console.log): AIServices {
  const gemini = cfg.GEMINI_API_KEY
    ? { apiKey: cfg.GEMINI_API_KEY, model: cfg.GEMINI_MODEL, embeddingModel: cfg.GEMINI_EMBEDDING_MODEL }
    : null;
  const groq = cfg.GROQ_API_KEY
    ? { apiKey: cfg.GROQ_API_KEY, model: cfg.GROQ_MODEL, whisperModel: cfg.GROQ_WHISPER_MODEL }
    : null;

  let choice = cfg.LLM_PROVIDER;
  if (choice === 'auto') choice = gemini ? 'gemini' : groq ? 'groq' : 'mock';
  if (choice === 'gemini' && !gemini) {
    log('LLM_PROVIDER=gemini but GEMINI_API_KEY is missing; falling back to mock mode.');
    choice = 'mock';
  }
  if (choice === 'groq' && !groq) {
    log('LLM_PROVIDER=groq but GROQ_API_KEY is missing; falling back to mock mode.');
    choice = 'mock';
  }

  const llm = choice === 'gemini' && gemini ? new GeminiLLM(gemini) : choice === 'groq' && groq ? new GroqLLM(groq) : new MockLLM();
  const embedder = gemini && choice !== 'mock' ? new GeminiEmbedder(gemini) : new HashEmbedder();
  const transcriber = groq ? new GroqWhisper(groq) : null;

  log(`AI: llm=${llm.name}, embeddings=${embedder.model}, transcription=${transcriber ? transcriber.name : 'off'}`);
  return { llm, embedder, transcriber };
}
