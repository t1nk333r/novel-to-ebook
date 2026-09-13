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
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectContext } from "../lib/context";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { projectDetailsSchema } from "../lib/schema";
import { useArmedDelete } from "@/hooks/use-armed-delete";
import { isRtl, LANGUAGES } from "@/lib/language";
import { useDeleteChapter, useUpdateProject } from "../lib/hooks";
import { addChapterModal } from "./add-chapter-modal";
import { API_URL, invalidateQuery, $api } from "@/lib/api";
import { toast } from "sonner";
import { useNavigate } from "react-router";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ChapterImportProgress from "./import-progress";
import ChapterList from "./chapter-list";
import ProjectCover from "@/components/project-cover";
import { apiAuthHeader } from "@/lib/api-auth";
import { getApiToken } from "@/stores/auth.store";

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
    <div className="flex flex-col items-stretch overflow-hidden border-r w-full sm:w-80">
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
  const armedDelete = useArmedDelete();

  const onDelete = (id: number) => {
    armedDelete.confirmThen(String(id), () => deleteChapter(id));
  };

  const onRemoveAllChapters = () => {
    // Two presses: the first arms, the second deletes. See useArmedDelete.
    armedDelete.confirmThen("all", () => chapters?.forEach((c) => deleteChapter(c.id)));
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
          variant={armedDelete.armed === "all" ? "destructive" : "ghost"}
          size="sm"
          className="mx-1"
          aria-label={
            armedDelete.armed === "all"
              ? "Press again to delete every chapter"
              : "Delete all chapters"
          }
          title={
            armedDelete.armed === "all"
              ? "Press again to delete every chapter"
              : "Delete all chapters"
          }
          onClick={onRemoveAllChapters}
        >
          <Trash2Icon />
        </Button>
      </div>

      <div className="border-t mt-1 flex flex-col items-stretch py-1">
        <ChapterList chapters={chapters || []} onDelete={onDelete} armedId={armedDelete.armed} />
        <ChapterImportProgress />
      </div>
    </div>
  );
}

function ProjectDetails() {
  const removeProject = $api.useMutation("delete", "/projects/{id}");
  const armedDelete = useArmedDelete();

  const onDeleteProject = () =>
    removeProject.mutate(
      { params: { path: { id: project.id } } },
      {
        onSuccess() {
          invalidateQuery("/projects");
          toast.success("Project deleted");
          navigate("/projects");
        },
        onError(error) {
          toast.error((error as Error).message);
        },
      },
    );
  const { project } = useProjectContext();
  const form = useForm<any>({ resolver: zodResolver(projectDetailsSchema as any) as any });
  const update = useUpdateProject(project.id);
  const exportProject = $api.useMutation("post", "/projects/{id}/export");
  const navigate = useNavigate();

  const coverFileInput = useRef<HTMLInputElement>(null);
  const [uploadingCover, setUploadingCover] = useState(false);

  const uploadCover = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so picking the same file twice still fires a change.
    event.target.value = "";
    if (!file) return;

    setUploadingCover(true);
    try {
      const url = `${API_URL}/projects/${project.id}/cover`;
      const headers: Record<string, string> = {
        "Content-Type": file.type || "application/octet-stream",
        ...apiAuthHeader(url, window.location.origin, getApiToken()),
      };
      const res = await fetch(url, { method: "POST", headers, body: file });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `Upload failed (${res.status})`);
      }

      const { cover } = (await res.json()) as { cover: string };
      // The form auto-saves whatever it holds on the next keystroke, so it has
      // to learn the new value — otherwise the old cover goes straight back.
      form.setValue("cover", cover);
      invalidateQuery("/projects/{id}");
      invalidateQuery("/projects");
      toast.success("Cover uploaded");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setUploadingCover(false);
    }
  };

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
        {/* An uploaded cover needs no URL and no reachability from the server:
            the bytes are stored with the project. That is the only option when
            the artwork sits on a host the server cannot reach. */}
        <div className="flex items-center gap-3">
          <ProjectCover
            src={form.watch("cover")}
            alt="Cover preview"
            className="w-14 aspect-3/4 object-cover rounded border bg-muted"
          />
          <div className="min-w-0">
            <input
              ref={coverFileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={uploadCover}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={uploadingCover}
              onClick={() => coverFileInput.current?.click()}
            >
              {uploadingCover ? <Loader2 className="size-4 animate-spin" /> : null}
              Upload from this device
            </Button>
            <FieldDescription>Stored on the server — no URL needed.</FieldDescription>
          </div>
        </div>
      </Field>
      <Field>
        <FieldLabel>Language</FieldLabel>
        <Select
          value={form.watch("language") || "en"}
          onValueChange={(value) => form.setValue("language", value, { shouldDirty: true })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="en" />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((language) => (
              <SelectItem key={language.code} value={language.code}>
                {language.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isRtl(form.watch("language")) ? (
          <FieldDescription>
            Right-to-left: the exported EPUB lays out from the right and pages that way.
          </FieldDescription>
        ) : null}
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

      <Separator className="mt-16" />

      <Button
        variant={armedDelete.armed === "project" ? "destructive" : "outline"}
        className="w-full"
        aria-label={
          armedDelete.armed === "project" ? "Press again to delete this project" : "Delete this project"
        }
        title={
          armedDelete.armed === "project"
            ? "Press again to delete this project and all its chapters"
            : "Delete this project and all its chapters"
        }
        onClick={() => armedDelete.confirmThen("project", onDeleteProject)}
      >
        <Trash2Icon className="mr-2 size-4" />
        {armedDelete.armed === "project" ? "Press again to delete" : "Delete project"}
      </Button>
      <FieldDescription>
        Deletes the project and every chapter in it. This cannot be undone.
      </FieldDescription>
    </div>
  );
}
