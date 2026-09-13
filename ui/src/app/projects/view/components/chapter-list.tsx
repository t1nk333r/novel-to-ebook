import { $api, invalidateQuery, type JsonRes } from "@/lib/api";
import { useSortable } from "@dnd-kit/react/sortable";
import { DragDropProvider } from "@dnd-kit/react";
import {
  FileIcon,
  GripVerticalIcon,
  PencilIcon,
  TrashIcon,
} from "lucide-react";
import { openEditorTab } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { renameChapterModal } from "./rename-chapter-modal";
import { useRef } from "react";
import { sortableMoveArray } from "@/lib/utils";
import { useProjectContext } from "../lib/context";
import { toast } from "sonner";

type Chapter = JsonRes<"/projects/{projectId}/chapters", "get">[number];

type Props = {
  chapters: Chapter[];
  onDelete: (id: number) => void;
  /** The row currently armed for a second press, from useArmedDelete. */
  armedId?: string | null;
};

export default function ChapterList({ chapters, onDelete, armedId }: Props) {
  const projectId = useProjectContext().project.id;
  const reorder = $api.useMutation(
    "put",
    "/projects/{projectId}/chapters/reorder",
    {
      onSuccess() {
        invalidateQuery("/projects/{projectId}/chapters");
      },
      onError(err) {
        toast.error((err as Error).message);
      },
    },
  );

  return (
    <DragDropProvider
      onDragEnd={(event) => {
        const items = sortableMoveArray(chapters, event);
        reorder.mutate({
          params: { path: { projectId } },
          body: { ids: items.map((i) => i.id) },
        });
      }}
    >
      {!chapters && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <FileIcon className="size-8" />
          <p className="text-center text-sm">No Chapter Added</p>
        </div>
      )}

      {chapters.map((c, idx) => (
        <ChapterItem key={c.id} data={c} index={idx} onDelete={onDelete} armed={armedId === String(c.id)} />
      ))}
    </DragDropProvider>
  );
}

function ChapterItem({
  data: c,
  index,
  onDelete,
  armed,
}: {
  data: Chapter;
  index: number;
  onDelete: Props["onDelete"];
  armed?: boolean;
}) {
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const { ref } = useSortable({ id: c.id, index, handle: handleRef });

  return (
    <div
      ref={ref}
      className="flex items-center hover:bg-primary/10 transition-colors group"
    >
      <button
        className="px-4 h-8 cursor-pointer flex-1 text-left truncate text-xs"
        onClick={() => openEditorTab(c)}
      >
        {c.title}
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-none hidden group-hover:flex"
        onClick={() => renameChapterModal.onOpen({ title: c.title, id: c.id })}
      >
        <PencilIcon />
      </Button>
      <Button
        variant={armed ? "destructive" : "ghost"}
        size="icon-sm"
        // Always visible: hover-only left it undiscoverable, on a phone and on a
        // desktop alike. It is a two-press action now, so showing it is safe.
        className="rounded-none text-muted-foreground hover:text-destructive"
        aria-label={armed ? "Press again to delete this chapter" : "Delete this chapter"}
        title={armed ? "Press again to delete this chapter" : "Delete this chapter"}
        onClick={() => onDelete(c.id)}
      >
        <TrashIcon />
      </Button>
      <Button
        ref={handleRef}
        variant="ghost"
        size="icon-sm"
        className="rounded-none hidden group-hover:flex"
      >
        <GripVerticalIcon />
      </Button>
    </div>
  );
}
