import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { Reply } from '../src/core/reply.js';
import { Scheduler } from '../src/scheduler.js';
import { makeApp, USER, ZONE } from './helpers.js';

function setup(hour = 8) {
  const app = makeApp();
  const sent: { userId: string; replies: Reply[] }[] = [];
  const scheduler = new Scheduler({
    service: app.service,
    bot: app.bot,
    userIds: [USER],
    digestHour: hour,
    notify: async (userId, replies) => void sent.push({ userId, replies }),
  });
  return { ...app, scheduler, sent };
}
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE });

describe('Scheduler reminders', () => {
  it('fires a timed reminder once, when due', async () => {
    const { service, scheduler, sent } = setup();
    await service.capture(USER, 'call mom at 6pm'); // due 18:00 local today
    expect((await scheduler.tick(at('2025-03-12T17:59:00'))).reminders).toBe(0);
    expect((await scheduler.tick(at('2025-03-12T18:00:30'))).reminders).toBe(1);
    expect((await scheduler.tick(at('2025-03-12T18:05:00'))).reminders).toBe(0);
    expect(sent[0]!.replies[0]!.text).toContain('Reminder');
    expect(sent[0]!.replies[0]!.buttons![0]!.map((b) => b.data)).toEqual(['done:1', 'snz:1:1h', 'snz:1:tomorrow']);
  });

  it('does not remind for date-only or done notes', async () => {
    const { service, scheduler, sent } = setup(23);
    await service.capture(USER, 'call bank tomorrow');
    const t = await service.capture(USER, 'call mom at 6pm');
    await service.markDone(USER, t.id);
    await scheduler.tick(at('2025-03-14T12:00:00'));
    expect(sent).toHaveLength(0);
  });

  it('silently retires very stale reminders (e.g. after long downtime)', async () => {
    const { service, scheduler, sent } = setup(23);
    const n = await service.capture(USER, 'call mom at 6pm');
    await scheduler.tick(at('2025-03-20T12:00:00'));
    expect(sent).toHaveLength(0);
    expect((await service.get(USER, n.id))!.remindedAt).not.toBeNull();
  });

  it('retries next tick if sending fails', async () => {
    const app = makeApp();
    let fail = true;
    const sent: string[] = [];
    const s = new Scheduler({
      service: app.service,
      bot: app.bot,
      userIds: [USER],
      digestHour: 23,
      notify: async (_u, r) => {
        if (fail) throw new Error('telegram down');
        sent.push(r[0]!.text);
      },
    });
    await app.service.capture(USER, 'call mom at 6pm');
    await s.tick(at('2025-03-12T18:01:00'));
    expect(sent).toHaveLength(0);
    fail = false;
    await s.tick(at('2025-03-12T18:02:00'));
    expect(sent).toHaveLength(1);
  });

  it('ignores notes of other users', async () => {
    const { service, scheduler, sent } = setup(23);
    await service.capture('stranger', 'call mom at 6pm');
    await scheduler.tick(at('2025-03-12T18:01:00'));
    expect(sent).toHaveLength(0);
  });
});

describe('Scheduler digest', () => {
  it('sends once per day at/after the digest hour, not before', async () => {
    const { service, scheduler, sent } = setup(8);
    await service.capture(USER, 'todo: water plants');
    expect((await scheduler.tick(at('2025-03-12T07:59:00'))).digests).toBe(0);
    expect((await scheduler.tick(at('2025-03-12T08:00:00'))).digests).toBe(1);
    expect((await scheduler.tick(at('2025-03-12T08:01:00'))).digests).toBe(0);
    expect(sent[0]!.replies[0]!.text).toContain('Good morning');
    expect(sent[0]!.replies[0]!.text).toContain('Water plants');
    expect((await scheduler.tick(at('2025-03-13T08:00:00'))).digests).toBe(1);
  });

  it('catches up shortly after a restart but not much later in the day', async () => {
    const a = setup(8);
    await a.service.capture(USER, 'todo: x');
    expect((await a.scheduler.tick(at('2025-03-12T11:00:00'))).digests).toBe(1);
    const b = setup(8);
    await b.service.capture(USER, 'todo: x');
    expect((await b.scheduler.tick(at('2025-03-12T20:00:00'))).digests).toBe(0);
  });

  it('skips the digest when there is nothing at all', async () => {
    const { scheduler, sent } = setup(8);
    expect((await scheduler.tick(at('2025-03-12T08:00:00'))).digests).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('includes overdue, today and upcoming sections with done-buttons', async () => {
    const { service, scheduler, sent, store } = setup(8);
    await service.capture(USER, 'call A today');
    await service.capture(USER, 'call B tomorrow');
    const old = await service.capture(USER, 'call C today');
    await store.update(USER, old.id, { dueAt: '2025-03-10T14:00:00.000Z', dueHasTime: false });
    await service.capture(USER, 'buy milk, eggs');
    await scheduler.tick(at('2025-03-12T08:00:00'));
    const r = sent[0]!.replies[0]!;
    expect(r.text).toMatch(/Overdue[\s\S]*Call C[\s\S]*Due today[\s\S]*Call A[\s\S]*Coming up[\s\S]*Call B/);
    expect(r.text).toContain('2 items on your shopping list');
    expect(r.buttons!.flat().map((b) => b.data)).toEqual([`done:${old.id}`, 'done:1']);
  });
});
