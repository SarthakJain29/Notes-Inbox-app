import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { SqliteStore } from '../db/sqlite.js';

/** npm run export [-- out.json] : dump all notes (no embeddings) as JSON for backup. */
const cfg = loadConfig();
const userId = cfg.ALLOWED_TELEGRAM_USER_ID ? String(cfg.ALLOWED_TELEGRAM_USER_ID) : 'cli-user';
const store = new SqliteStore(cfg.DATABASE_PATH);
const notes = await store.all(userId);
const out = process.argv[2] ?? `notes-export-${new Date().toISOString().slice(0, 10)}.json`;
fs.writeFileSync(out, JSON.stringify(notes, null, 2));
console.log(`Wrote ${notes.length} notes to ${out}`);
store.close();
