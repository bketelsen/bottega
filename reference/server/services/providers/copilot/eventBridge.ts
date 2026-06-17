// EventEmitter → async-generator bridge.
//
// `ProviderRunResult.events` is an `AsyncIterable<UnifiedMessage>` (the
// Codex/OpenCode SDKs hand us async streams directly). The Copilot SDK is
// callback-based instead: `session.on(handler)` fires for every event. This
// push-queue adapts that callback firehose into an async iterable.
//
// Producers call `push(item)` for each value and `close()` (clean end, e.g.
// `session.idle`) or `fail(err)` (terminal error). The consumer iterates
// with `for await`. Backpressure is bounded only by memory — turns are
// short-lived and the consumer (the streaming loop) drains promptly, so an
// unbounded buffer is fine and avoids dropping events mid-turn.

export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  /** Resolver for a consumer awaiting the next value. */
  private pendingResolve: ((result: IteratorResult<T>) => void) | null = null;
  private pendingReject: ((err: unknown) => void) | null = null;
  private closed = false;
  private failure: unknown = null;

  /** Enqueue a value. No-op once closed/failed. */
  push(item: T): void {
    if (this.closed) return;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      resolve({ value: item, done: false });
      return;
    }
    this.values.push(item);
  }

  /** Signal a clean end of stream. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      resolve({ value: undefined, done: true });
    }
  }

  /** Signal a terminal error. The consumer's `for await` rejects. */
  fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = err;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false });
        }
        if (this.failure !== null) {
          const err =
            this.failure instanceof Error
              ? this.failure
              : new Error('AsyncPushQueue stream failed');
          this.failure = null;
          return Promise.reject(err);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.pendingResolve = resolve;
          this.pendingReject = reject;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        // Consumer abandoned iteration — discard any buffered values and
        // terminate (distinct from close(), which lets buffered values drain).
        this.values.length = 0;
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
