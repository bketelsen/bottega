import { describe, it, expect } from 'vitest';
import { AsyncPushQueue } from './eventBridge.js';

async function drain<T>(q: AsyncPushQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) out.push(item);
  return out;
}

describe('AsyncPushQueue', () => {
  it('yields values pushed before iteration starts, then completes on close', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(await drain(q)).toEqual([1, 2]);
  });

  it('delivers a value pushed while a consumer is awaiting', async () => {
    const q = new AsyncPushQueue<string>();
    const collected = drain(q);
    // Let the consumer reach its pending await before pushing.
    await Promise.resolve();
    q.push('a');
    q.push('b');
    q.close();
    expect(await collected).toEqual(['a', 'b']);
  });

  it('completes (done) when closed with no buffered values', async () => {
    const q = new AsyncPushQueue<number>();
    const collected = drain(q);
    await Promise.resolve();
    q.close();
    expect(await collected).toEqual([]);
  });

  it('rejects the consumer when fail() is called', async () => {
    const q = new AsyncPushQueue<number>();
    const collected = drain(q);
    await Promise.resolve();
    q.fail(new Error('boom'));
    await expect(collected).rejects.toThrow('boom');
  });

  it('surfaces a queued failure after draining buffered values', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.fail(new Error('later'));
    const it = q[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ value: 1, done: false });
    await expect(it.next()).rejects.toThrow('later');
  });

  it('ignores push/close/fail once closed', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.close();
    q.push(2); // no-op
    q.fail(new Error('ignored')); // no-op
    expect(await drain(q)).toEqual([1]);
  });

  it('early return() from the consumer closes the queue', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.push(2);
    const it = q[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ value: 1, done: false });
    await expect(it.return!()).resolves.toEqual({ value: undefined, done: true });
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
