export interface LocalRuntimeLifecycleOptions {
  stopRelay: () => void;
  pendingRelay: () => Promise<unknown> | null;
  stopServices: () => Array<Promise<unknown> | null | undefined>;
  releaseStateLock: () => Promise<void>;
  setExitCode: (code: number) => void;
  log?: (message: string) => void;
}

export class LocalRuntimeLifecycle {
  #options: LocalRuntimeLifecycleOptions;
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: LocalRuntimeLifecycleOptions) {
    this.#options = options;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  async shutdown(
    exitCode: number,
    reason: string,
    options: { awaitRelay?: boolean } = {}
  ): Promise<void> {
    if (this.#shutdownPromise) return await this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = (async () => {
      this.#options.log?.(`[operator] shutting down (${reason})`);
      this.#options.stopRelay();
      // Fatal relay shutdown can originate from the relay promise itself.
      // Skip that promise only on that explicitly requested path to avoid
      // self-wait; every normal shutdown drains it before releasing state.
      const pendingRelay = options.awaitRelay === false ? null : this.#options.pendingRelay();
      const services = this.#options.stopServices().filter(Boolean) as Array<Promise<unknown>>;
      await Promise.allSettled([pendingRelay, ...services].filter(Boolean) as Array<Promise<unknown>>);
      await this.#options.releaseStateLock();
      this.#options.setExitCode(exitCode);
    })();
    return await this.#shutdownPromise;
  }
}
