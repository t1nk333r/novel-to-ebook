import BackButton from "@/components/ui/back-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { $api, invalidateQuery } from "@/lib/api";
import { ArrowLeftIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

export default function ProjectListPage() {
  const [search, setSearch] = useState("");
  const { data: projects } = $api.useQuery("get", "/projects");
  const create = $api.useMutation("post", "/projects");
  const remove = $api.useMutation("delete", "/projects/{id}");
  const navigate = useNavigate();

  const onDeleteProject = (id: string, title: string) => {
    // Deleting a project takes its chapters with it, and there is no undo, so
    // this asks — same pattern the chapter list uses for the same reason.
    if (!confirm(`Delete "${title}"? Its chapters are deleted with it, and this cannot be undone.`)) {
      return;
    }

    remove.mutate(
      { params: { path: { id } } },
      {
        onSuccess() {
          invalidateQuery("/projects");
          toast.success("Project deleted");
        },
        onError(err) {
          toast.error((err as Error).message);
        },
      },
    );
  };

  const onCreateProject = () => {
    create.mutate(
      { body: { title: "Untitled", author: "Anonymous" } },
      {
        onSuccess(data) {
          navigate(`/projects/${data.id}`);
          toast.success("Project created");
        },
        onError(err) {
          toast.error((err as Error).message);
        },
      },
    );
  };

  return (
    <div>
      <div className="flex items-center gap-2 p-6 pb-0">
        <InputGroup className="w-full max-w-3xl">
          <InputGroupAddon align="inline-start">
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
      </div>

      <BackButton to="/" variant="ghost" className="ml-2 mt-6">
        <ArrowLeftIcon className="size-6" />
      </BackButton>

      <h2 className="font-medium text-3xl mx-6 mt-2">Projects</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] p-2">
        <button
          className="text-foreground p-4 rounded hover:bg-secondary flex flex-col items-center justify-center gap-2 border m-4 cursor-pointer"
          title={"123"}
          onClick={onCreateProject}
          disabled={create.isPending}
        >
          <PlusIcon />
          <p>New</p>
        </button>

        {projects?.map((project) => (
          <Link
            key={project.id}
            to={`/projects/${project.id}`}
            className="text-foreground p-4 hover:bg-secondary"
            title={project.title}
          >
            <div className="w-full aspect-3/4 bg-primary/10 shadow rounded relative overflow-hidden">
              <div className="w-full h-full flex flex-col items-center justify-center text-center p-4">
                <p className="text-md line-clamp-3">{project.title}</p>
                <p className="text-sm mt-2 opacity-50">{project.author}</p>
              </div>

              {project.cover ? (
                <img
                  src={project.cover}
                  alt={project.title}
                  className="absolute z-1 inset-0 w-full h-full object-cover rounded overflow-hidden shadow"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : null}

              <button
                type="button"
                aria-label={`Delete ${project.title}`}
                title="Delete project"
                // Always visible, but quiet: a hover-only control cannot be
                // discovered on a touch screen, and this app is used on phones.
                className="absolute z-2 top-1 right-1 rounded bg-background/70 p-1.5 text-foreground/60 hover:bg-destructive hover:text-white transition-colors cursor-pointer"
                onClick={(event) => {
                  // The card is a link; without this, deleting also navigates.
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteProject(project.id, project.title);
                }}
                disabled={remove.isPending}
              >
                <Trash2Icon className="size-4" />
              </button>
            </div>

            <div className="line-clamp-2 mt-2 text-xs font-medium">
              {project.title}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
