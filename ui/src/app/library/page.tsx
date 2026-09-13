import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  ArrowLeftIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { $api } from "@/lib/api";
import { useState } from "react";
import { matchProjectForKey } from "./lib/match-project";
import { Link, useSearchParams } from "react-router";
import { getLibraryTitle } from "./lib/utils";
import { cn } from "@/lib/utils";
import { useOfflineApiQuery } from "@/hooks/use-offline";
import { useHistories, useRescanLibrary } from "./lib/hooks";
import LibraryList, { type LibraryView } from "./components/library-list";
import { usePersistedState } from "@/hooks/use-persisted-state";
import LibraryViewMenu from "./components/library-view-menu";

export default function LibraryPage() {
  const [search, setSearch] = useState("");
  const { data: history } = useHistories();
  const { data: books } = useOfflineApiQuery("get", "/library");
  // Books belong to projects; the library is where you *see* them, the project is
  // where you work on them.
  const { data: projects } = $api.useQuery("get", "/projects");
  const projectForKey = (key: string) =>
    matchProjectForKey(key, projects ?? []) as { id: string; title: string } | null;
  const [searchParams] = useSearchParams();
  const [libraryView, setLibraryView] = usePersistedState<LibraryView>(
    "libraryView",
    {
      mode: "grid",
      orderBy: "name",
      sort: 1,
    },
  );
  const baseDir = searchParams.get("dir") || "";
  const rescan = useRescanLibrary();

  return (
    <div className="min-h-screen bg-background">
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
        <div className="flex-1" />
        <Button asChild>
          <Link to="/projects">
            <PlusIcon /> Create
          </Link>
        </Button>
      </div>

      {!search && !baseDir && history && history.length > 0 && (
        <>
          <h2 className="font-medium text-xl mx-6 mt-10">Continue Reading</h2>
          <LibraryList items={history} horizontal projectForKey={projectForKey} />
        </>
      )}

      {search || baseDir ? (
        <Button
          asChild
          variant="ghost"
          className="ml-2 mt-6"
          onClick={() => setSearch("")}
        >
          <Link to="/">
            <ArrowLeftIcon className="size-6" />
          </Link>
        </Button>
      ) : null}

      <div className="flex items-center gap-2 mt-10 mx-6">
        <h2
          className={cn(
            "font-medium text-xl flex-1 truncate",
            search || baseDir ? "text-3xl mt-2" : "",
          )}
        >
          {getLibraryTitle({ search, baseDir })}
        </h2>
        <LibraryViewMenu
          view={libraryView}
          onChange={(e) => setLibraryView({ ...libraryView, ...e })}
        />
        <Button
          variant="outline"
          size="icon"
          onClick={() => rescan.mutate(null as never)}
          disabled={rescan.isPending}
        >
          <RefreshCwIcon className={rescan.isPending ? "animate-spin" : ""} />
        </Button>
      </div>

      <LibraryList
        projectForKey={projectForKey}
        items={books}
        search={search}
        baseDir={baseDir}
        view={libraryView}
      />
    </div>
  );
}
