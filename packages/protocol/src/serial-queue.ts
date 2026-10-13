/**
 * Serialize asynchronous work while keeping the result of each job observable
 * by its caller. A rejected job never blocks the jobs queued after it.
 */
export class SerialPromiseQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(job: () => T | PromiseLike<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
