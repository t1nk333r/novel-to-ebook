import { HTTPError } from "./error";

export class WorkloadLimitError extends HTTPError {
  constructor(name: string) {
    super(`${name} concurrency limit reached`, {
      status: 429,
      code: "WORKLOAD_LIMIT_REACHED",
    });
  }
}

export class BoundedExecutor {
  private active = 0;

  constructor(
    private readonly name: string,
    private readonly maximum: number,
  ) {}

  tryAcquire() {
    if (this.active >= this.maximum) {
      throw new WorkloadLimitError(this.name);
    }

    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }

  async run<T>(operation: () => Promise<T>) {
    const release = this.tryAcquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  get activeCount() {
    return this.active;
  }
}
