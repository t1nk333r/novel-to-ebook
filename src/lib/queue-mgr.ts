import { uuid } from "./utils";

type TaskStatus = "queued" | "running" | "success" | "error";

export interface TaskContext {
  setProgress: (value: number, title?: string) => void;
}

export type TaskHandler<T = any> = (ctx: TaskContext) => Promise<T>;

export interface TaskOptions {
  namespace?: string;
  retries?: number;
  retryDelay?: number;
}

export interface QueueConfig {
  maxConcurrent?: number;
  delayMs?: number;
}

export interface Task<T = any> {
  id: string;
  namespace?: string;

  status: TaskStatus;
  progress: number;
  title: string;

  retries: number;
  retryDelay: number;
  attempt: number;

  result?: T;
  error?: string;

  handler: TaskHandler<T>;
}

type EventMap = {
  added: Task;
  started: Task;
  progress: Task;
  success: Task;
  error: Task;
  retrying: Task;
  finished: Task;
  update: Task;
};

type Listener<K extends keyof EventMap> = (task: EventMap[K]) => void;

export class QueueManager {
  private queue: Task[] = [];
  private running = 0;

  private listeners: {
    [K in keyof EventMap]?: Listener<K>[];
  } = {};

  private config: Required<QueueConfig>;

  constructor(config?: QueueConfig) {
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 1,
      delayMs: config?.delayMs ?? 0,
    };
  }

  private emit<K extends keyof EventMap>(event: K, task: EventMap[K]) {
    // Listeners can be async — the SSE handlers write to a socket. Writing to
    // a disconnected client must not surface as an unhandled rejection, and
    // the route's own abort loop tears the listener down within a second.
    this.listeners[event]?.forEach((fn) => {
      Promise.resolve(fn(task)).catch(() => {});
    });
  }

  on<K extends keyof EventMap>(event: K, fn: Listener<K>) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }

    this.listeners[event]!.push(fn);

    return () => {
      this.listeners[event] = this.listeners[event]?.filter(
        (f) => f !== fn,
      ) as never;
    };
  }

  add<T>(handler: TaskHandler<T>, options?: TaskOptions): Task<T> {
    const task: Task<T> = {
      id: uuid(),
      namespace: options?.namespace,

      status: "queued",
      progress: 0,
      title: "",

      retries: options?.retries ?? 0,
      retryDelay: options?.retryDelay ?? 1000,
      attempt: 0,

      handler,
    };

    this.queue.push(task);
    this.emit("added", task);
    this.emit("update", task);
    this.process();

    return task;
  }

  private async process() {
    while (this.running < this.config.maxConcurrent) {
      // Pick the task itself, never an index into a filtered copy: finished
      // tasks stay in `queue` for 30s so progress streams can still report
      // them, and indexing the filtered list against the unfiltered array
      // re-ran the most recent finished task — re-extracting every link and
      // inserting the chapters a second time.
      const task = this.queue.find((t) => t.status === "queued");
      if (!task) return;

      this.run(task);

      if (this.config.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.config.delayMs));
      }
    }
  }

  private async run(task: Task) {
    this.running++;

    task.status = "running";
    task.attempt++;

    this.emit("started", task);
    this.emit("update", task);

    const ctx: TaskContext = {
      setProgress: (p, title) => {
        task.progress = p;
        if (title) task.title = title ?? "";
        this.emit("progress", task);
        this.emit("update", task);
      },
    };

    try {
      const result = await task.handler(ctx);

      task.result = result;
      task.status = "success";

      this.emit("success", task);
      this.emit("update", task);
    } catch (err) {
      task.error = (err as Error)?.message || "Something went wrong";

      if (task.attempt <= task.retries) {
        this.emit("retrying", task);
        this.emit("update", task);

        // The task object is still in `queue`; re-queueing is a status flip,
        // not a second entry (a push would duplicate it in progress streams).
        setTimeout(() => {
          task.status = "queued";
          this.process();
        }, task.retryDelay);
      } else {
        task.status = "error";

        this.emit("error", task);
        this.emit("update", task);
      }
    } finally {
      this.running--;

      if (task.status === "success" || task.status === "error") {
        this.emit("finished", task);
        this.emit("update", task);

        // Retire the finished task once progress streams have had a chance to
        // report it. Only terminal tasks are retired: a retry is still live.
        setTimeout(() => {
          const taskIdx = this.queue.indexOf(task);
          if (taskIdx >= 0) {
            this.queue.splice(taskIdx, 1);
            this.emit("update", task);
          }
        }, 30 * 1000);
      }

      this.process();
    }
  }

  getTasks(namespace?: string) {
    if (!namespace) {
      return [...this.queue];
    }
    return this.queue.filter((t) => t.namespace === namespace);
  }

  getRunningCount() {
    return this.running;
  }
}
