import type { BookRelocate } from "@/app/reader/lib/types";
import OfflineImage from "@/components/offline-image";
import { $api, API_URL, invalidateQuery } from "@/lib/api";
import { cn, getRelativeTime } from "@/lib/utils";
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { BlurhashCanvas } from "react-blurhash";
import { BookOpenIcon, EyeIcon, FilePlus2Icon, PencilIcon, UserIcon } from "lucide-react";

export type LibraryItem = {
  key: string;
  location?: BookRelocate;
  name?: string;
  metadata?: any;
  cover?: string | null;
  coverHash?: string | null;
  parent?: string | null;
  isDirectory?: boolean;
};

export type LibraryView = {
  mode: "grid" | "list";
  orderBy: "created" | "modified" | "name" | "readAt";
  sort: number;
};

type Props = {
  items?: LibraryItem[];
  search?: string | null;
  baseDir?: string | null;
  horizontal?: boolean;
  view?: LibraryView;
  /**
   * The project a book came from, if any. Clicking a book then opens the project
   * — where the chapters, cleanup and export live — instead of only the reader.
   */
  projectForKey?: (key: string) => { id: string; title: string } | null;
};

const LibraryList = ({
  items,
  search,
  baseDir,
  horizontal,
  view,
  projectForKey,
}: Props) => {
  const navigate = useNavigate();
  const adopt = $api.useMutation("post", "/library/adopt");
  const scrollRef = useRef<HTMLDivElement>(null!);
  const { mode = "grid", orderBy, sort = 1 } = view || {};
  // In a list row or the horizontal strip the cover box is ~48x64 and clips, so
  // actions go beside the title rather than over the artwork.
  const compact = mode === "list" || Boolean(horizontal);

  const onAdopt = async (item: LibraryItem) => {
    try {
      const created = await adopt.mutateAsync({ body: { key: item.key } });
      invalidateQuery("/library");
      invalidateQuery("/projects");
      toast.success(`Project created with ${created.chapters} chapter(s)`);
      navigate(`/projects/${created.id}`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!horizontal || !el) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;

      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };

    el.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", handleWheel);
    };
  }, [horizontal]);

  const filtered = useMemo(() => {
    let res = items || [];

    // filter items
    if (baseDir !== null) {
      res = res.filter((i) => i.parent === baseDir);
    }
    if (search) {
      res = res.filter((i) =>
        i.name?.toLowerCase().includes(search.toLowerCase()),
      );
    }

    // sort
    if (orderBy === "created") {
      res = res.sort(
        (a, b) => (a.metadata?.created || 0) - (b.metadata?.created || 0),
      );
    } else if (orderBy === "modified") {
      res = res.sort(
        (a, b) => (a.metadata?.modified || 0) - (b.metadata?.modified || 0),
      );
    } else if (orderBy === "name") {
      res = res.sort((a, b) => a.name?.localeCompare(b.name || "") || 0);
    } else if (orderBy === "readAt") {
      res = res.sort(
        (a, b) => (a.metadata?.readAt || 0) - (b.metadata?.readAt || 0),
      );
    }
    if (sort === -1) {
      res = res.reverse();
    }

    return res;
  }, [items, search, baseDir, orderBy, sort]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        "grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] p-2",
        horizontal && "overflow-x-auto flex items-stretch",
        mode === "list" ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3" : "",
      )}
    >
      {filtered?.map((item) => {
        const project = item.isDirectory ? null : projectForKey?.(item.key) ?? null;

        return (
        <Link
          key={item.key}
          to={
            item.isDirectory
              ? `/?dir=${item.key}`
              : `/reader/?book=${encodeURIComponent(item.key)}`
          }
          className={cn(
            "text-foreground p-4 hover:bg-secondary",
            horizontal &&
              "shrink-0 min-w-40 w-[calc(100vw/4-8px)] max-w-[180px]",
            mode === "list"
              ? "px-0 mx-4 flex items-stretch gap-x-4 border-b"
              : "",
          )}
          title={item.metadata?.title || item.name}
        >
          <div
            className={cn(
              "aspect-3/4 bg-primary/10 rounded relative overflow-hidden shadow shrink-0",
              mode === "list" ? "h-16" : "w-full",
            )}
          >
            <div className="w-full h-full flex flex-col items-center justify-center text-center p-4">
              <p className="text-md line-clamp-3">
                {item.metadata?.title || item.name}
              </p>
              <p className="text-sm mt-2 opacity-50">
                {item.metadata?.creator}
              </p>
            </div>

            {item.coverHash != null && (
              /* @ts-ignore */
              <BlurhashCanvas
                hash={item.coverHash}
                className="absolute z-1 inset-0 w-full h-full"
                width={3}
                height={4}
              />
            )}

            <OfflineImage
              src={item.cover ? API_URL + item.cover : null}
              alt={item.name}
              className="absolute z-2 inset-0 w-full h-full object-cover"
            />

            {!project && !item.isDirectory && !compact ? (
              <button
                type="button"
                aria-label={`Create a project from ${item.name}`}
                title="Create a project from this book"
                className="absolute z-4 top-1 right-1 rounded border border-border/60 bg-background/90 p-1.5 text-foreground shadow-sm hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onAdopt(item);
                }}
              >
                <FilePlus2Icon className="size-4" />
              </button>
            ) : null}

            {project && !compact ? (
              // Overlaid on the cover in grid view, where there is room.
              <div className="absolute z-4 top-1 right-1 flex items-center gap-1">
              <button
                type="button"
                aria-label={`Edit ${item.name}`}
                title={`Edit ${project.title}`}
                className="rounded border border-border/60 bg-background/90 p-1.5 text-foreground shadow-sm hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  navigate(`/projects/${project.id}`);
                }}
              >
                <PencilIcon className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Read ${item.name}`}
                title={`Read ${item.name}`}
                className="rounded border border-border/60 bg-background/90 p-1.5 text-foreground shadow-sm hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  navigate(`/reader/?book=${encodeURIComponent(item.key)}`);
                }}
              >
                <BookOpenIcon className="size-4" />
              </button>
            </div>
            ) : null}

            {item.location?.fraction && (
              <div className="absolute z-3 bottom-0 left-0 w-full bg-background/20 flex items-center justify-between">
                <div
                  className="bg-green-500 h-0.75"
                  style={{ width: `${item.location.fraction * 100}%` }}
                />
              </div>
            )}
          </div>

          <div className="flex justify-center items-stretch flex-col">
            <p
              className={cn(
                "line-clamp-2 text-xs font-medium",
                mode === "list" && "text-sm font-normal",
              )}
            >
              {item.metadata?.title || item.name}
            </p>

            {(project || (!item.isDirectory && compact)) ? (
              <div className="flex items-center gap-1 mt-1">
                {!project ? (
                  <button
                    type="button"
                    aria-label={`Create a project from ${item.name}`}
                    title="Create a project from this book"
                    className="rounded border border-border/60 bg-background/90 p-1 text-foreground hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void onAdopt(item);
                    }}
                  >
                    <FilePlus2Icon className="size-3.5" />
                  </button>
                ) : null}
                {project ? (
                <button
                  type="button"
                  aria-label={`Edit ${item.name}`}
                  title={`Edit ${project.title}`}
                  className="rounded border border-border/60 bg-background/90 p-1 text-foreground hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    navigate(`/projects/${project.id}`);
                  }}
                >
                  <PencilIcon className="size-3.5" />
                </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Read ${item.name}`}
                  title={`Read ${item.name}`}
                  className="rounded border border-border/60 bg-background/90 p-1 text-foreground hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    navigate(`/reader/?book=${encodeURIComponent(item.key)}`);
                  }}
                >
                  <BookOpenIcon className="size-3.5" />
                </button>
              </div>
            ) : null}

            {mode === "list" ? (
              <>
                {item.metadata?.creator ? (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <UserIcon className="shrink-0 size-3" />
                    <p className="truncate text-xs text-muted-foreground">
                      {item.metadata?.creator}
                    </p>
                  </div>
                ) : null}

                {item.metadata?.readAt ? (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <EyeIcon className="shrink-0 size-3" />
                    <p className="flex-1 truncate text-xs">
                      {getRelativeTime(new Date(item.metadata.readAt))}
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </Link>
        );
      })}
    </div>
  );
};

export default LibraryList;
