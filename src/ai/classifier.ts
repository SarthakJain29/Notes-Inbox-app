import type { DateTime } from 'luxon';
import type { LLMProvider } from '../llm/types.js';
import type { Classification } from '../types.js';
import { heuristicClassify } from './heuristic.js';
import { parseBatch, parseClassification } from './parse.js';
import { batchSystemPrompt, batchUserPrompt, systemPrompt, userPrompt, type PromptInput } from './prompt.js';

export interface ClassifyResult extends Classification {
  /** Which engine produced it: provider name, or "heuristic" (mock mode / fallback after failure). */
  processedBy: string;
}

export interface Classifier {
  classify(input: PromptInput, now: DateTime): Promise<ClassifyResult>;
  classifyBatch(inputs: PromptInput[], now: DateTime): Promise<ClassifyResult[]>;
}

/** Merge things the user typed explicitly over the model's output. */
function applyUserOverrides(c: Classification, input: PromptInput): Classification {
  const out = { ...c };
  if (input.userTitle?.trim()) out.title = input.userTitle.trim().slice(0, 80);
  if (input.typeHint) out.type = input.typeHint;
  if (input.userTags?.length) out.tags = [...new Set([...input.userTags, ...c.tags])].slice(0, 8);
  return out;
}

export class LLMClassifier implements Classifier {
  constructor(
    private readonly llm: LLMProvider,
    private readonly zone: string,
    private readonly log: (m: string) => void = () => {},
  ) {}

  async classify(input: PromptInput, now: DateTime): Promise<ClassifyResult> {
    if (this.llm.isMock) return { ...heuristicClassify(input, now), processedBy: 'heuristic' };
    try {
      const text = await this.llm.generateJson({ system: systemPrompt(now), user: userPrompt(input) });
      const c = applyUserOverrides(parseClassification(text, input.content, this.zone), input);
      return { ...c, processedBy: this.llm.name };
    } catch (err) {
      this.log(`classify failed (${(err as Error).message}); using heuristic fallback`);
      return { ...heuristicClassify(input, now), processedBy: 'heuristic' };
    }
  }

  /** One LLM call for many notes (saves free-tier quota during imports). Falls back per item. */
  async classifyBatch(inputs: PromptInput[], now: DateTime): Promise<ClassifyResult[]> {
    if (inputs.length === 0) return [];
    if (this.llm.isMock) return inputs.map((i) => ({ ...heuristicClassify(i, now), processedBy: 'heuristic' }));
    let parsed: (Classification | null)[] = inputs.map(() => null);
    try {
      const text = await this.llm.generateJson({ system: batchSystemPrompt(now), user: batchUserPrompt(inputs) });
      parsed = parseBatch(
        text,
        inputs.map((i) => i.content),
        this.zone,
      );
    } catch (err) {
      this.log(`batch classify failed (${(err as Error).message}); using heuristic fallback`);
    }
    return inputs.map((input, i) => {
      const c = parsed[i];
      return c ? { ...applyUserOverrides(c, input), processedBy: this.llm.name } : { ...heuristicClassify(input, now), processedBy: 'heuristic' };
    });
  }
}
