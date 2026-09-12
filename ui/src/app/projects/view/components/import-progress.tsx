import { streamSSE } from "@/lib/sse";
import { useEffect, useState } from "react";
import { useProjectContext } from "../lib/context";
import { invalidateQuery } from "@/lib/api";
import { AlertCircleIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";

type Task = {
  id: string;
  title: string;
  progress: number;
  status: string;
  error: any;
};

export default function ChapterImportProgress() {
  const { project } = useProjectContext();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setTasks([]);
    setStreamError(null);

    // The promise has to be handled: an abort on unmount, a 401, or a dropped
    // connection otherwise rejected into nowhere and left the panel silently
    // stale.
    streamSSE(`/projects/${project.id}/chapters/import` as never, "get", {
      signal: controller.signal,
      onMessage: (event, data) => {
        if (event === "tasks") {
          setTasks(data);
          invalidateQuery("/projects/{projectId}/chapters");
        }
        if (event === "error") {
          toast.error(data.error || "Something went wrong");
        }
      },
    }).catch((err: Error) => {
      if (controller.signal.aborted) return;
      setStreamError(err.message || "Import progress stream stopped");
    });

    return () => {
      controller.abort("unmount");
    };
  }, [project.id]);

  return (
    <>
      {streamError ? (
        <div className="px-4 flex items-center gap-1 py-2 text-xs">
          <AlertCircleIcon className="size-4 text-destructive" />
          <p className="flex-1 truncate text-destructive">{streamError}</p>
        </div>
      ) : null}

      {tasks.map((task) => (
        <div
          key={task.id}
          className="px-4 flex items-center gap-1 py-2 text-xs text-muted-foreground"
        >
          {task.status === "error" ? (
            <>
              <AlertCircleIcon className="size-4 text-destructive" />
              <p className="flex-1 truncate text-destructive">
                {task.error || "Something went wrong"}
              </p>
            </>
          ) : (
            <>
              <p className="flex-1 truncate">{task.title}</p>
              <p className="mr-1">{Math.round(task.progress)}%</p>
              {task.status === "running" && (
                <Loader2 className="animate-spin size-4" />
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
}
