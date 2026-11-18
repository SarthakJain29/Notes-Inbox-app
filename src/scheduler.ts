import { DateTime } from 'luxon';
import type { InboxBot } from './core/bot.js';
import type { Reply } from './core/reply.js';
import type { NotesService } from './core/service.js';

export type Notify = (userId: string, replies: Reply[]) => Promise<void>;

export interface SchedulerOptions {
  service: NotesService;
  bot: InboxBot;
  notify: Notify;
  userIds: string[];
  digestHour: number;
  log?: (m: string) => void;
}

const MAX_REMINDER_AGE_MS = 24 * 3600 * 1000;
/** If the app was down at digest time, still send it up to this many hours late. */
const DIGEST_CATCHUP_HOURS = 6;

/**
 * Minute-resolution in-process scheduler: timed reminders + the morning digest.
 * State (last digest date, reminded flags) lives in the DB, so restarts never double-send.
 * tick() is public/pure-ish so it can be unit-tested with a fake clock.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly log: (m: string) => void;

  constructor(private readonly o: SchedulerOptions) {
    this.log = o.log ?? (() => {});
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`scheduler error: ${(e as Error).message}`)), intervalMs);
    this.timer.unref?.();
    void this.tick().catch((e) => this.log(`scheduler error: ${(e as Error).message}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: DateTime = this.o.service.now()): Promise<{ reminders: number; digests: number }> {
    if (this.running) return { reminders: 0, digests: 0 };
    this.running = true;
    try {
      return { reminders: await this.sendReminders(now), digests: await this.sendDigests(now) };
    } finally {
      this.running = false;
    }
  }

  private async sendReminders(now: DateTime): Promise<number> {
    const { service, bot, notify } = this.o;
    const due = await service.storeRef.dueReminders(now.toUTC().toISO()!);
    let sent = 0;
    for (const n of due) {
      if (!this.o.userIds.includes(n.userId)) continue;
      const age = now.toMillis() - DateTime.fromISO(n.dueAt!).toMillis();
      // Very stale reminders (e.g. imported notes, long downtime) are not worth a ping; the digest lists them as overdue.
      if (age <= MAX_REMINDER_AGE_MS) {
        try {
          await notify(n.userId, [bot.reminder(n)]);
          sent++;
        } catch (err) {
          this.log(`reminder for #${n.id} failed, will retry: ${(err as Error).message}`);
          continue;
        }
      }
      await service.markReminded(n.userId, n.id);
    }
    return sent;
  }

  private async sendDigests(now: DateTime): Promise<number> {
    const { service, bot, notify } = this.o;
    if (now.hour < this.o.digestHour || now.hour >= this.o.digestHour + DIGEST_CATCHUP_HOURS) return 0;
    const today = now.toFormat('yyyy-MM-dd');
    let sent = 0;
    for (const userId of this.o.userIds) {
      const key = `last_digest:${userId}`;
      if ((await service.storeRef.getMeta(key)) === today) continue;
      const data = await service.digestData(userId);
      const empty = !data.overdue.length && !data.dueToday.length && !data.upcoming.length && !data.openTaskCount && !data.shopping.length;
      if (!empty) {
        try {
          await notify(userId, await bot.digest(userId));
          sent++;
        } catch (err) {
          this.log(`digest failed, will retry next tick: ${(err as Error).message}`);
          continue;
        }
      }
      await service.storeRef.setMeta(key, today);
    }
    return sent;
  }
}
