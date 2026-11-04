import fs from 'node:fs';
import { createApp } from '../app.js';
import { LLMClassifier } from '../ai/classifier.js';
import { loadConfig } from '../config.js';
import { SqliteStore } from '../db/sqlite.js';
import { importMessages } from '../import/run.js';
import { parseWhatsAppChat, type DateOrder } from '../import/whatsapp.js';

const USAGE = `Import a WhatsApp chat export into Notes Inbox.

Usage: npm run import:whatsapp -- <chat.txt> [options]

Options:
  --user <id>             Telegram user id to import for (default: ALLOWED_TELEGRAM_USER_ID, else "cli-user")
  --author "<name>"       Only import messages sent by this sender (required if the chat has several senders)
  --date-order dmy|mdy|ymd|auto   How dates are written in the export (default auto; ambiguous files fall back to dmy)
  --batch <n>             Notes per AI call (default 8)
  --delay-ms <n>          Pause between AI calls, for free-tier rate limits (default 2000)
  --done-older-than <d>   Import tasks older than <d> days as already done
  --limit <n>             Only import the first n messages
  --dry-run               Classify and print a summary, but write nothing
  --help

Export from WhatsApp: open the chat -> ⋮ / name -> More -> Export chat -> Without media.
Safe to re-run: already-imported messages are skipped.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

async function main() {
  if (flag('--help') || process.argv.length < 3) {
    console.log(USAGE);
    return;
  }
  const file = process.argv[2]!;
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);

  const cfg = loadConfig();
  const dryRun = flag('--dry-run');
  const userId = arg('--user') ?? (cfg.ALLOWED_TELEGRAM_USER_ID ? String(cfg.ALLOWED_TELEGRAM_USER_ID) : 'cli-user');
  const log = (m: string) => console.log(`  · ${m}`);
  const app = createApp(cfg, { store: dryRun ? new SqliteStore(':memory:') : undefined, log });

  const parsed = parseWhatsAppChat(fs.readFileSync(file, 'utf8'), { zone: cfg.TIMEZONE, dateOrder: (arg('--date-order') as DateOrder | 'auto' | undefined) ?? 'auto' });
  console.log(`Parsed ${parsed.messages.length} messages (skipped: ${parsed.skipped.system} system, ${parsed.skipped.media} media, ${parsed.skipped.empty} empty).`);
  console.log(`Date order: ${parsed.dateOrder}${parsed.dateOrderGuessed ? ' (GUESSED — every date was ambiguous; pass --date-order mdy if wrong)' : ''}`);
  const authors = Object.entries(parsed.authors).sort((a, b) => b[1] - a[1]);
  console.log('Senders: ' + authors.map(([n, c]) => `${n} (${c})`).join(', '));

  let messages = parsed.messages;
  const author = arg('--author');
  if (author) messages = messages.filter((m) => m.sender === author);
  else if (authors.length > 1) throw new Error('Several senders found. Re-run with --author "<your name>" to import just your own messages.');
  if (!messages.length) throw new Error('Nothing to import.');

  const classifier = new LLMClassifier(app.ai.llm, cfg.TIMEZONE, log);
  const doneOlder = arg('--done-older-than');
  const summary = await importMessages(app.service, classifier, messages, {
    userId,
    dryRun,
    batchSize: Number(arg('--batch') ?? 8),
    delayMs: Number(arg('--delay-ms') ?? 2000),
    limit: arg('--limit') ? Number(arg('--limit')) : undefined,
    doneOlderThanDays: doneOlder ? Number(doneOlder) : undefined,
    onProgress: (p) => process.stdout.write(`\r  ${p.processed}/${p.total} classified…`),
  });
  process.stdout.write('\n');
  console.log(`${dryRun ? 'DRY RUN — nothing written. ' : ''}Imported ${summary.imported} of ${summary.total} (${summary.duplicates} already present).`);
  console.log('By type: ' + Object.entries(summary.byType).map(([t, n]) => `${t} ${n}`).join(', '));
  if (summary.heuristicFallbacks) console.log(`${summary.heuristicFallbacks} notes were filed offline (AI unavailable). Send /reprocess to the bot later to improve them.`);
  app.store.close();
}

main().catch((e) => {
  console.error(`\nError: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
