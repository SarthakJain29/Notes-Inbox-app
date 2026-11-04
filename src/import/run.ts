import { DateTime } from 'luxon';
import { parseCapture } from '../ai/capture.js';
import type { Classifier } from '../ai/classifier.js';
import type { PromptInput } from '../ai/prompt.js';
import { importHash, type NotesService } from '../core/service.js';
import type { WhatsAppMessage } from './whatsapp.js';

export interface ImportOptions {
  userId: string;
  /** Number of notes per LLM call. */
  batchSize?: number;
  /** Pause between LLM batches to respect free-tier rate limits. */
  delayMs?: number;
  /** Import tasks older than this many days as already done. */
  doneOlderThanDays?: number;
  limit?: number;
  dryRun?: boolean;
  onProgress?: (p: ImportProgress) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ImportProgress {
  processed: number;
  total: number;
  imported: number;
  duplicates: number;
}

export interface ImportSummary {
  total: number;
  imported: number;
  duplicates: number;
  byType: Record<string, number>;
  heuristicFallbacks: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Bulk-classify and store parsed WhatsApp messages.
 *  - idempotent: each message gets a hash of (timestamp, text); re-running skips what's already imported
 *  - one LLM call per batch (saves free-tier quota); embeddings are generated in bulk at the end
 *  - imported notes keep their ORIGINAL timestamp; due dates already in the past are dropped (kept in the context line)
 */
export async function importMessages(
  svc: NotesService,
  classifier: Classifier,
  messages: WhatsAppMessage[],
  opts: ImportOptions,
): Promise<ImportSummary> {
  const batchSize = opts.batchSize ?? 8;
  const sleep = opts.sleep ?? defaultSleep;
  const store = svc.storeRef;
  const summary: ImportSummary = { total: 0, imported: 0, duplicates: 0, byType: {}, heuristicFallbacks: 0 };
  const list = opts.limit ? messages.slice(0, opts.limit) : messages;
  summary.total = list.length;

  // De-duplicate (against the DB and within the file) before spending any LLM calls.
  const pending: { msg: WhatsAppMessage; hash: string }[] = [];
  const seen = new Set<string>();
  for (const msg of list) {
    const hash = importHash(msg.timestamp, msg.text);
    if (seen.has(hash) || (await store.hasImportHash(opts.userId, hash))) {
      summary.duplicates++;
      continue;
    }
    seen.add(hash);
    pending.push({ msg, hash });
  }

  const report = (processed: number) => opts.onProgress?.({ processed, total: pending.length, imported: summary.imported, duplicates: summary.duplicates });

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const inputs: PromptInput[] = batch.map(({ msg }) => {
      const p = parseCapture(msg.text);
      const sentLocal = DateTime.fromISO(msg.timestamp).setZone(svc.timezone).toFormat("yyyy-MM-dd'T'HH:mm");
      return { content: p.content || msg.text, userTitle: p.title, typeHint: p.typeHint, userTags: p.tags, sentAt: sentLocal };
    });

    if (opts.dryRun) {
      const results = await classifier.classifyBatch(inputs, svc.now());
      results.forEach((r) => (summary.byType[r.type] = (summary.byType[r.type] ?? 0) + 1));
      summary.imported += batch.length;
      report(i + batch.length);
      continue;
    }

    const results = await classifier.classifyBatch(inputs, svc.now());
    for (let j = 0; j < batch.length; j++) {
      const { msg, hash } = batch[j]!;
      const res = results[j]!;
      let { due, context } = res;
      const now = svc.now();
      if (due) {
        const dueDt = DateTime.fromISO(due, { zone: svc.timezone });
        if (dueDt.isValid && dueDt < now) {
          context = `${context ? context + ' ' : ''}(originally due ${due.replace('T', ' ')})`.trim();
          due = null;
        }
      }
      const ageDays = now.diff(DateTime.fromISO(msg.timestamp), 'days').days;
      const status = res.type === 'task' && opts.doneOlderThanDays !== undefined && ageDays > opts.doneOlderThanDays ? 'done' : 'open';
      await svc.persist(opts.userId, msg.text, { ...res, due, context: context.slice(0, 240) }, {
        source: 'whatsapp',
        createdAt: msg.timestamp,
        importHash: hash,
        status,
        deferEmbedding: true,
      });
      summary.imported++;
      summary.byType[res.type] = (summary.byType[res.type] ?? 0) + 1;
      if (res.processedBy === 'heuristic') summary.heuristicFallbacks++;
    }
    report(i + batch.length);
    if (i + batchSize < pending.length) await sleep(opts.delayMs ?? 2000);
  }

  if (!opts.dryRun && summary.imported > 0) {
    // Embed everything in bulk (50 per API call).
    for (let guard = 0; guard < 200; guard++) {
      const r = await svc.reindex(opts.userId, 500);
      if (r.done === 0 || r.remaining === 0) break;
    }
  }
  return summary;
}
