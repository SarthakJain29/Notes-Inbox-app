import http from 'node:http';
import { webhookCallback } from 'grammy';
import { createApp } from './app.js';
import { loadConfig, requireTelegramConfig } from './config.js';
import { Scheduler } from './scheduler.js';
import { BOT_COMMANDS, createTelegramBot, sendReplies } from './telegram/bot.js';

async function main() {
  const cfg = loadConfig();
  const tg = requireTelegramConfig(cfg);
  const log = (m: string) => console.log(`[notes-inbox] ${m}`);
  const app = createApp(cfg, { log });
  const bot = createTelegramBot({ ...tg, allowedUserId: tg.userId, app, log });

  const scheduler = new Scheduler({
    service: app.service,
    bot: app.bot,
    userIds: [String(tg.userId)],
    digestHour: cfg.DIGEST_HOUR,
    notify: (userId, replies) => sendReplies(bot, Number(userId), replies),
    log,
  });

  // Tiny HTTP server: /healthz for uptime pings (keeps free hosts awake) and the webhook endpoint.
  const webhookPath = cfg.WEBHOOK_SECRET ? `/telegram/${cfg.WEBHOOK_SECRET}` : '/telegram';
  const handleWebhook = cfg.BOT_MODE === 'webhook' ? webhookCallback(bot, 'http', { secretToken: cfg.WEBHOOK_SECRET }) : null;
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: cfg.BOT_MODE }));
    } else if (handleWebhook && req.method === 'POST' && req.url === webhookPath) {
      void handleWebhook(req, res);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(cfg.PORT, resolve));
  log(`HTTP listening on :${cfg.PORT} (mode=${cfg.BOT_MODE}, tz=${cfg.TIMEZONE}, digest at ${cfg.DIGEST_HOUR}:00)`);

  await bot.api.setMyCommands(BOT_COMMANDS).catch((e) => log(`setMyCommands failed: ${e.message}`));

  const shutdown = async (sig: string) => {
    log(`${sig} received, shutting down`);
    scheduler.stop();
    if (cfg.BOT_MODE === 'polling') await bot.stop().catch(() => {});
    server.close();
    app.store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (cfg.BOT_MODE === 'webhook') {
    if (!cfg.WEBHOOK_URL || !cfg.WEBHOOK_SECRET) {
      throw new Error('BOT_MODE=webhook requires WEBHOOK_URL and WEBHOOK_SECRET (see developer.md).');
    }
    await bot.init();
    await bot.api.setWebhook(`${cfg.WEBHOOK_URL.replace(/\/$/, '')}${webhookPath}`, { secret_token: cfg.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    log('Webhook registered.');
    scheduler.start();
  } else {
    scheduler.start();
    log('Starting long polling…');
    await bot.start({ allowed_updates: ['message', 'callback_query'], onStart: (me) => log(`Bot @${me.username} is up. Send it a message.`) });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
