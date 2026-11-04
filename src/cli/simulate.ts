import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { SqliteStore } from '../db/sqlite.js';
import { htmlToPlain, type Reply } from '../core/reply.js';
import { Scheduler } from '../scheduler.js';

/**
 * Local simulator: type messages as if you were in Telegram. Same pipeline as the real bot.
 *   npm run simulate                 -> uses a throwaway in-memory DB
 *   npm run simulate -- --persist    -> uses DATABASE_PATH
 * Meta commands: `:click <n>` press a button, `:digest` run the digest, `:tick` run the scheduler, `:quit`.
 */
const USER = 'cli-user';

async function main() {
  const cfg = loadConfig();
  const persist = process.argv.includes('--persist');
  const app = createApp(cfg, { store: persist ? undefined : new SqliteStore(':memory:'), log: (m) => console.log(`\x1b[90m· ${m}\x1b[0m`) });
  const ctx = { userId: USER };

  let buttons: { label: string; data: string }[] = [];
  const show = (replies: Reply[]) => {
    for (const r of replies) {
      console.log('\n\x1b[36mBot:\x1b[0m ' + htmlToPlain(r.text).replace(/\n/g, '\n     '));
      if (r.document) console.log(`     📎 ${r.document.filename} (${r.document.content.length} bytes)`);
      buttons = (r.buttons ?? []).flat();
      if (buttons.length) console.log('     ' + buttons.map((b, i) => `[${i + 1}] ${b.label}`).join('  '));
    }
  };

  const scheduler = new Scheduler({
    service: app.service,
    bot: app.bot,
    userIds: [USER],
    digestHour: 0,
    notify: async (_u, replies) => show(replies),
    log: (m) => console.log(`\x1b[90m· ${m}\x1b[0m`),
  });

  console.log(`Notes Inbox simulator (${persist ? 'persistent DB: ' + cfg.DATABASE_PATH : 'in-memory DB'}) — type a note or /help. :click N presses a button, :tick runs reminders, :quit exits.`);
  const rl = readline.createInterface({ input, output, prompt: '\n\x1b[33mYou:\x1b[0m ' });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    try {
      if (text === ':quit' || text === ':q') break;
      else if (text.startsWith(':click')) {
        const b = buttons[Number(text.split(/\s+/)[1]) - 1];
        if (!b) console.log('No such button.');
        else {
          const res = await app.bot.handleCallback(ctx, b.data);
          if (res) {
            if (res.toast) console.log(`     (toast: ${res.toast})`);
            show([res.reply]);
          }
        }
      } else if (text === ':tick') {
        const r = await scheduler.tick();
        console.log(`     (tick: ${r.reminders} reminders, ${r.digests} digests)`);
      } else if (text) {
        show(await app.bot.handleText(ctx, text));
      }
    } catch (err) {
      console.log(`\x1b[31mError: ${(err as Error).message}\x1b[0m`);
    }
    rl.prompt();
  }
  rl.close();
  app.store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
