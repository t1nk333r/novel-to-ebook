import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { cn } from "@/lib/utils";
import {
  BookTextIcon,
  FilePlusCornerIcon,
  ListOrderedIcon,
  Loader2,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { useProjectContext } from "../lib/context";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { projectDetailsSchema } from "../lib/schema";
import { useDeleteChapter, useUpdateProject } from "../lib/hooks";
import { toast } from "sonner";
import { addChapterModal } from "./add-chapter-modal";
import { $api } from "@/lib/api";
import { Separator } from "@/components/ui/separator";
import { useNavigate } from "react-router";
import ChapterImportProgress from "./import-progress";
import ChapterList from "./chapter-list";

const tabs = [
  {
    id: "toc",
    name: "Table of Contents",
    icon: ListOrderedIcon,
    Component: TableOfContents,
  },
  {
    id: "details",
    name: "Project Details",
    icon: BookTextIcon,
    Component: ProjectDetails,
  },
];

export default function Sidebar() {
  const { project } = useProjectContext();
  const [curTab, setTab] = usePersistedState(
    "projects/sidebar-tab",
    tabs[0]?.id,
  );

  const tab = useMemo(() => {
    const item = tabs.find((tab) => tab.id === curTab);
    if (!item) return null;

    const Comp = item.Component;
    const element = Comp ? <Comp /> : null;
    return { ...item, Component: undefined, element };
  }, [curTab]);

  return (
    <div className="flex flex-col items-stretch overflow-hidden border-r w-80">
      <div className="bg-secondary border-b h-12 flex items-center pl-4 pr-2">
        <p className="text-sm font-medium flex-1 truncate mr-2">
          {project?.title}
        </p>
        <Button size="sm" onClick={() => setTab("details")}>
          <SaveIcon />
          Export
        </Button>
      </div>
      <div className="flex-1 flex items-stretch overflow-hidden">
        <nav className="w-12 bg-secondary border-r">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              variant="ghost"
              className={cn(
                "w-full aspect-square h-auto rounded-none border-b",
                curTab === tab.id && "bg-primary/10",
              )}
              onClick={() => setTab(tab.id)}
            >
              <tab.icon />
            </Button>
          ))}
        </nav>
        <aside className="bg-background flex flex-col items-stretch flex-1 overflow-hidden">
          <div className="px-4 py-3">
            <p className="text-xs uppercase truncate">{tab?.name || ""}</p>
          </div>

          <div className="flex-1 overflow-y-auto pb-3">{tab?.element}</div>
        </aside>
      </div>
    </div>
  );
}

function TableOfContents() {
  const { project } = useProjectContext();
  const { data: chapters } = $api.useQuery(
    "get",
    "/projects/{projectId}/chapters",
    { params: { path: { projectId: project.id } } },
  );
  const deleteChapter = useDeleteChapter(project.id);

  const onDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this chapter?")) return;
    deleteChapter(id);
  };

  const onRemoveAllChapters = () => {
    if (!confirm("Are you sure you want to delete all chapter?")) return;
    chapters?.forEach((c) => deleteChapter(c.id));
  };

  return (
    <div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="mx-1"
          onClick={() => addChapterModal.onOpen()}
        >
          <FilePlusCornerIcon />
          Add
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="mx-1"
          onClick={onRemoveAllChapters}
        >
          <Trash2Icon />
        </Button>
      </div>

      <div className="border-t mt-1 flex flex-col items-stretch py-1">
        <ChapterList chapters={chapters || []} onDelete={onDelete} />
        <ChapterImportProgress />
      </div>
    </div>
  );
}

function ProjectDetails() {
  const { project } = useProjectContext();
  const form = useForm<any>({ resolver: zodResolver(projectDetailsSchema as any) as any });
  const update = useUpdateProject(project.id);
  const exportProject = $api.useMutation("post", "/projects/{id}/export");
  const navigate = useNavigate();

  useEffect(() => {
    try {
      form.reset(projectDetailsSchema.parse(project));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [project.id]);

  useEffect(() => {
    const cb = form.watch((data) => update.debounce(data));
    return () => cb.unsubscribe();
  }, []);

  const onExport = () => {
    exportProject.mutate(
      { params: { path: { id: project.id } } },
      {
        onSuccess(data) {
          toast.success("Project exported successfully!", {
            action: (
              <Button
                size="sm"
                onClick={() => navigate(`/reader/?book=${data.key}`)}
              >
                View
              </Button>
            ),
          });
        },
        onError(err) {
          toast.error((err as Error).message);
        },
      },
    );
  };

  return (
    <div className="px-4 space-y-3">
      <Field>
        <FieldLabel>Title</FieldLabel>
        <InputGroup>
          <InputGroupInput placeholder="Untitled" {...form.register("title")} />
        </InputGroup>
      </Field>
      <Field>
        <FieldLabel>Author</FieldLabel>
        <InputGroup>
          <InputGroupInput
            placeholder="Anonymous"
            {...form.register("author")}
          />
        </InputGroup>
      </Field>
      <Field>
        <FieldLabel>Cover</FieldLabel>
        <InputGroup>
          <InputGroupInput placeholder="https://" {...form.register("cover")} />
        </InputGroup>
      </Field>
      <Field>
        <FieldLabel>Language</FieldLabel>
        <InputGroup>
          <InputGroupInput placeholder="en" {...form.register("language")} />
        </InputGroup>
      </Field>

      <Separator className="mt-16" />

      <p className="text-xs uppercase">Export Settings</p>
      <Field>
        <FieldLabel>Output Directory</FieldLabel>
        <FieldDescription>Leave empty for root dir</FieldDescription>
        <InputGroup>
          <InputGroupInput {...form.register("config.outDir")} />
        </InputGroup>
      </Field>

      <Button onClick={onExport} disabled={exportProject.isPending}>
        {exportProject.isPending && <Loader2 className="mr-2 animate-spin" />}
        Save as EPUB
      </Button>
    </div>
  );
}
