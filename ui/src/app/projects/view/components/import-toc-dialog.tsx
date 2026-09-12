import { useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import ScreenshotViewer from "./screenshot-viewer";
import { useMutation } from "@tanstack/react-query";
import { Field, FieldLabel } from "@/components/ui/field";
import { SearchIcon, SquareDashedMousePointerIcon, XIcon } from "lucide-react";
import * as cheerio from "cheerio";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import BrowserActionsInput, {
  type BrowserAction,
} from "./browser-actions-input";
import { searchChapters } from "@/lib/utils";
import { streamSSE } from "@/lib/sse";
import { toast } from "sonner";
import { createDisclosure } from "@/lib/store";
import { useProjectContext } from "../lib/context";
import { $api, invalidateQuery } from "@/lib/api";

export const importTOCModal = createDisclosure();

export default function ImportTOCDialog() {
  const { project } = useProjectContext();
  const { open } = importTOCModal.useStore();

  const previewRef = useRef<HTMLDivElement>(null!);
  const [url, setUrl] = usePersistedState("import-toc-dialog/url", "");
  const [linkSelector, setLinkSelector] = usePersistedState(
    "import-toc-dialog/link-selector",
    "",
  );
  const [titleSelector, setTitleSelector] = usePersistedState(
    "import-toc-dialog/title-selector",
    "",
  );
  const [browserActions, setBrowserActions] = usePersistedState<
    BrowserAction[]
  >("import-toc-dialog/browser-actions", []);
  const [onSelectFn, setSelectFn] = useState<((el: any) => void) | null>(null);
  const [selectType, setSelectType] = useState<"link" | "title" | null>(null);
  const [chapters, setChapters] = usePersistedState<
    { title: string; url: string; checked: boolean }[]
  >("import-toc-dialog/chapters", []);
  const [reversed, setReversed] = usePersistedState(
    "import-toc-dialog/reversed",
    false,
  );
  const [search, setSearch] = useState("");

  const filteredChapters = useMemo(() => {
    let items = chapters.map((i, idx) => ({ ...i, idx }));
    if (!search) return items;

    return searchChapters(items, (i) => i.title, search);
  }, [chapters, search]);

  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const {
    data: pageData,
    mutate: loadPage,
    isPending,
  } = useMutation<{
    elements: any[];
    url: string;
    pageSize: { width: number; height: number };
    html: string;
  }>({
    mutationFn: async () => {
      setScreenshot(null);

      let target = url;
      if (!/^https?:\/\//i.test(target)) target = "https://" + target;

      let res: any = null;
      await streamSSE("/projects/snapshot", "post", {
        body: {
          url: target,
          width: previewRef.current.offsetWidth,
          isFullPage: true,
          actions: browserActions.filter((i) => i.enabled),
        },
        onMessage: (event, data) => {
          if (event === "screenshot") {
            setScreenshot(data.img);
            setPageSize({ width: data.width, height: data.height });
          }
          if (event === "result") {
            res = data;
          }
        },
      });
      return res;
    },
    onError: (err) => toast.error(err.message),
  });

  const importChapters = $api.useMutation(
    "post",
    "/projects/{projectId}/chapters/import",
  );

  const onSelect = (type: "link" | "title", el: any) => {
    if (type === "link") {
      setLinkSelector(el.selector);
    }
    if (type === "title") {
      let parentSelector = linkSelector.split(" ").pop();
      let selector: string = el.selector || "";

      // cut selector from parent selector
      const parts = selector.split(" ");
      if (parentSelector)
        selector = parts
          .slice(parts.findIndex((i) => i === parentSelector) + 1)
          .join(" ");

      setTitleSelector(selector);
    }

    setSelectFn(null);
  };

  const onParse = () => {
    if (!pageData) return;

    const $ = cheerio.load(pageData.html);
    const res: { title: string; url: string; checked: boolean }[] = [];

    $(linkSelector).each((_, el) => {
      const $el = $(el);
      let title = $el.text().trim();
      let url = $el.attr("href") || "";

      if (titleSelector.length > 0) {
        const titleTxt = $el.find(titleSelector).text().trim();
        if (titleTxt.length > 0) title = titleTxt;
      }

      if (!url.startsWith("http")) url = new URL(pageData.url).origin + url;

      res.push({ title, url, checked: true });
    });

    if (reversed) {
      res.reverse();
    }

    setChapters(res);
  };

  const onToggleAll = (checked: boolean) => {
    setChapters((prev) => {
      const newVal = [...prev];
      filteredChapters.forEach((i) => (newVal[i.idx].checked = checked));
      return newVal;
    });
  };

  const onToggleCheck = (idx: number, checked: boolean) => {
    setChapters((prev) => {
      const newChapters = [...prev];
      newChapters[idx] = {
        ...newChapters[idx],
        checked,
      };
      return newChapters;
    });
  };

  const onImport = () => {
    if (!project) return;

    const res = chapters
      .filter((i) => i.checked)
      .map((i) => ({ url: i.url, title: i.title }));

    importChapters.mutate(
      {
        params: { path: { projectId: project.id } },
        body: { links: res, delayMs: 3000 },
      },
      {
        onSuccess() {
          invalidateQuery("/projects/{projectId}/chapters");
          importTOCModal.setOpen(false);
          toast.success("Import queue added.");
        },
        onError(err) {
          toast.error((err as Error).message);
        },
      },
    );
  };

  // See add-chapter-modal: closing in the same tick as another dialog opens
  // otherwise leaves this one mounted with its layer still active.
  if (!open) return null;

  return (
    <Dialog open onOpenChange={importTOCModal.setOpen}>
      <DialogContent className="md:max-w-[calc(100vw-4rem)]">
        <DialogHeader>
          <DialogTitle>Import Table of Contents</DialogTitle>
          <DialogDescription>
            You can import a table of contents from a page.
          </DialogDescription>
        </DialogHeader>

        <div className="w-full overflow-hidden">
          <div className="flex items-center gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Insert TOC/chapters page url here..."
            />
            <Button onClick={() => loadPage()} disabled={isPending}>
              Open
            </Button>
          </div>

          <div className="flex items-stretch h-[calc(90vh-200px)] mt-4 w-full gap-4">
            <div
              ref={previewRef}
              className="h-full flex-1 border rounded overflow-hidden"
            >
              <ScreenshotViewer
                screenshot={screenshot}
                elements={pageData?.elements}
                selectedSelector={null}
                pageSize={pageSize}
                isSelecting={onSelectFn != null}
                onSelect={onSelectFn}
                includeElements={selectType === "link" ? ["a"] : undefined}
              />
            </div>
            <div className="w-[30%] h-full overflow-y-auto">
              <Label>Actions</Label>
              <BrowserActionsInput
                className="mt-2"
                actions={browserActions}
                onChange={setBrowserActions}
                setSelectFn={(type, fn) => {
                  setSelectFn(onSelectFn ? null : () => fn);
                  setSelectType(type as never);
                }}
              />

              <Separator className="my-4" />

              <Field>
                <FieldLabel>Chapter Link Selector</FieldLabel>
                <InputGroup>
                  <InputGroupTextarea
                    placeholder="a.chapter-link"
                    className="min-h-auto"
                    value={linkSelector}
                    onChange={(e) => setLinkSelector(e.target.value)}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      onClick={() => {
                        setSelectFn(
                          onSelectFn
                            ? null
                            : () => (el: any) => onSelect("link", el),
                        );
                        setSelectType("link");
                      }}
                    >
                      <SquareDashedMousePointerIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>

              <Field className="mt-4">
                <FieldLabel>Chapter Title Selector (optional)</FieldLabel>
                <InputGroup>
                  <InputGroupTextarea
                    className="min-h-auto"
                    value={titleSelector}
                    onChange={(e) => setTitleSelector(e.target.value)}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      onClick={() => {
                        setSelectFn(
                          onSelectFn
                            ? null
                            : () => (el: any) => onSelect("title", el),
                        );
                        setSelectType("title");
                      }}
                    >
                      <SquareDashedMousePointerIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>

              <label className="flex items-start gap-2 text-sm cursor-pointer mt-4">
                <Checkbox
                  className="shrink-0 mt-0.5"
                  checked={reversed}
                  onCheckedChange={(checked) => setReversed(Boolean(checked))}
                />
                <span>Reverse Chapter Order</span>
              </label>

              <Button onClick={onParse} disabled={!pageData} className="mt-4">
                Parse
              </Button>

              <Separator className="my-4" />

              <InputGroup>
                <InputGroupAddon align="inline-start">
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="search, eg: 25-50, >=50, <10, 100"
                />
                {search ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setSearch("")}
                    >
                      <XIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>

              {filteredChapters.length > 0 && (
                <div className="space-y-2 mt-4 border p-4">
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <Checkbox
                      className="shrink-0 mt-0.5"
                      checked={filteredChapters.every((c) => c.checked)}
                      onCheckedChange={onToggleAll}
                    />
                    <span>Select All</span>
                  </label>

                  {filteredChapters.map((c, idx) => (
                    <label
                      key={idx}
                      className="flex items-start gap-2 text-sm cursor-pointer"
                    >
                      <Checkbox
                        className="shrink-0 mt-0.5"
                        checked={c.checked}
                        onCheckedChange={(checked) =>
                          onToggleCheck(c.idx, Boolean(checked))
                        }
                      />
                      <span>{c.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              disabled={!chapters.length || importChapters.isPending}
              onClick={onImport}
            >
              Import
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
