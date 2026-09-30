// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** An async operation that did not finish within its deadline. */
export class TimeoutError extends Error {
  constructor(readonly duration: number) {
    super(`Operation timed out after ${duration}ms`);
    this.name = "TimeoutError";
  }
}

/** The operation was called off. */
export class CancellationError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancellationError";
  }
}

/**
 * Runs `operation` with a hard timeout (mirrors iOS `withTimeout`). Past `ms`, the operation's
 * signal is aborted and `TimeoutError` is thrown at once: the caller is not held up waiting for a
 * stuck operation to notice.
 */
export function withTimeout<T>(ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);
    operation(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Resolves after `ms`; rejects with `CancellationError` as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancellationError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancellationError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
