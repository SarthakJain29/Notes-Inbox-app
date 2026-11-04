import { describe, expect, it } from 'vitest';
import { makeApp, USER } from './helpers.js';

const ctx = { userId: USER };

describe('InboxBot', () => {
  it('captures plain text with action buttons', async () => {
    const { bot } = makeApp();
    const [r] = await bot.handleText(ctx, 'buy milk, eggs #home');
    expect(r!.text).toContain('Saved #1');
    expect(r!.text).toContain('☐ milk');
    expect(r!.text).toContain('#home');
    expect(r!.buttons![0]!.map((b) => b.data)).toEqual(['done:1', 'refile:1', 'del:1']);
  });

  it('escapes HTML in user content', async () => {
    const { bot } = makeApp();
    const [r] = await bot.handleText(ctx, 'todo: fix <b>bold</b> & stuff');
    expect(r!.text).not.toContain('<b>bold</b>');
    expect(r!.text).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; stuff');
  });

  it('/tasks lists open tasks, /shopping lists items, empty states are friendly', async () => {
    const { bot } = makeApp();
    expect((await bot.handleText(ctx, '/tasks'))[0]!.text).toContain('No open tasks');
    await bot.handleText(ctx, 'call bank tomorrow');
    await bot.handleText(ctx, 'buy milk, eggs');
    const tasks = (await bot.handleText(ctx, '/tasks'))[0]!;
    expect(tasks.text).toContain('Call bank tomorrow');
    expect(tasks.text).not.toContain('milk');
    expect((await bot.handleText(ctx, '/shopping'))[0]!.text).toContain('☐ eggs');
  });

  it('/search needs a query and finds notes', async () => {
    const { bot } = makeApp();
    expect((await bot.handleText(ctx, '/search'))[0]!.text).toContain('Usage');
    await bot.handleText(ctx, 'Meeting with Priya: ship beta by 15 Feb');
    const r = (await bot.handleText(ctx, '/search Priya beta'))[0]!;
    expect(r.text).toContain('Priya');
    expect((await bot.handleText(ctx, '/search zzzxxyy'))[0]!.text).toContain('No notes found');
  });

  it('handles /command@botname and unknown commands', async () => {
    const { bot } = makeApp();
    expect((await bot.handleText(ctx, '/help@my_notes_bot'))[0]!.text).toContain('Notes Inbox');
    expect((await bot.handleText(ctx, '/wat'))[0]!.text).toContain('Unknown command');
  });

  it('/done, /delete, /type, /show work by id', async () => {
    const { bot, service } = makeApp();
    await bot.handleText(ctx, 'call bank tomorrow');
    expect((await bot.handleText(ctx, '/done 1'))[0]!.text).toContain('Done');
    expect((await service.get(USER, 1))!.status).toBe('done');
    expect((await bot.handleText(ctx, '/type 1 idea'))[0]!.text).toContain('Re-filed #1');
    expect((await bot.handleText(ctx, '/show 1'))[0]!.text).toContain('Original');
    await bot.handleText(ctx, '/delete 1');
    expect((await bot.handleText(ctx, '/show 1'))[0]!.text).toContain("can't find");
    expect((await bot.handleText(ctx, '/done abc'))[0]!.text).toContain('note id');
    expect((await bot.handleText(ctx, '/type 1 nonsense'))[0]!.text).toContain('Usage');
  });

  it('/export returns a JSON document', async () => {
    const { bot } = makeApp();
    await bot.handleText(ctx, 'buy milk');
    const r = (await bot.handleText(ctx, '/export'))[0]!;
    expect(JSON.parse(r.document!.content)).toHaveLength(1);
  });

  it('empty text gets a hint', async () => {
    const { bot } = makeApp();
    expect((await bot.handleText(ctx, '   '))[0]!.text).toContain('Send me');
  });
});

describe('InboxBot callbacks', () => {
  it('done → reopen, delete → undo, refile picker → type', async () => {
    const { bot, service } = makeApp();
    await bot.handleText(ctx, 'call bank tomorrow');

    let r = (await bot.handleCallback(ctx, 'done:1'))!;
    expect(r.reply.text).toContain('✔ done');
    expect(r.reply.buttons![0]![0]!.data).toBe('reopen:1');

    await bot.handleCallback(ctx, 'reopen:1');
    expect((await service.get(USER, 1))!.status).toBe('open');

    r = (await bot.handleCallback(ctx, 'refile:1'))!;
    expect(r.reply.buttons!.flat().map((b) => b.data)).toContain('type:1:idea');
    r = (await bot.handleCallback(ctx, 'type:1:idea'))!;
    expect(r.reply.text).toContain('Idea');

    r = (await bot.handleCallback(ctx, 'del:1'))!;
    expect(r.reply.buttons![0]![0]!.data).toBe('undel:1');
    await bot.handleCallback(ctx, 'undel:1');
    expect((await service.get(USER, 1))!.status).toBe('open');
  });

  it('snooze buttons work, bad payloads are ignored', async () => {
    const { bot, service } = makeApp();
    await bot.handleText(ctx, 'call mom at 6pm');
    expect((await bot.handleCallback(ctx, 'snz:1:1h'))!.toast).toBe('Snoozed');
    expect((await service.get(USER, 1))!.dueAt).toBe('2025-03-12T15:00:00.000Z');
    expect(await bot.handleCallback(ctx, 'snz:1:weird')).toBeNull();
    expect(await bot.handleCallback(ctx, 'bogus')).toBeNull();
    expect(await bot.handleCallback(ctx, 'type:1:nonsense')).toBeNull();
  });

  it('callbacks for missing notes degrade gracefully', async () => {
    const { bot } = makeApp();
    expect((await bot.handleCallback(ctx, 'done:999'))!.reply.text).toContain('no longer exists');
  });

  it("another user's callback cannot modify my notes", async () => {
    const { bot, service } = makeApp();
    await bot.handleText(ctx, 'call bank');
    await bot.handleCallback({ userId: 'intruder' }, 'del:1');
    expect((await service.get(USER, 1))!.status).toBe('open');
  });
});
