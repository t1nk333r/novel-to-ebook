import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createDisclosure } from "@/lib/store";
import ScreenshotViewer, {
  type ScreenshotViewerRef,
} from "./screenshot-viewer";
import { streamSSE } from "@/lib/sse";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { XIcon } from "lucide-react";

export const customSelectorModal = createDisclosure<{
  url: string;
  onSelect: (selectors: string[]) => void;
}>();

export default function CustomSelectorModal() {
  const disclosure = customSelectorModal.useStore();
  const { url, onSelect } = disclosure.data || {};

  const screenshotRef = useRef<ScreenshotViewerRef>(null!);

  const [curSelectors, setSelectors] = useState<string[]>([]);
  const [blockList, setBlockList] = useState<string[]>([]);

  const {
    data: pageData,
    mutate: loadPage,
    isPending,
  } = useMutation({
    mutationFn: async () => {
      let screenshot: string | null = null;
      let res: any = null;
      await streamSSE("/projects/snapshot", "post", {
        body: {
          url: url!,
          isFullPage: true,
          blockList,
        },
        onMessage: (event, data) => {
          if (event === "screenshot") {
            screenshot = data.img;
          }
          if (event === "result") {
            res = data;
          }
        },
      });
      return { ...res, screenshot } as {
        elements: any[];
        url: string;
        pageSize: { width: number; height: number };
        html: string;
        screenshot: string;
      };
    },
    onError: (err) => toast.error(err.message),
  });

  useEffect(() => {
    if (url) {
      loadPage();
      setSelectors([]);
    }
  }, [url]);

  // The mutation reads `blockList` from the render it was created in, so
  // reloading in the same tick sent the previous list and the element only
  // disappeared on the second click. Reload whenever the list changes.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }

    loadPage();
  }, [blockList]);

  const onAddBlockList = () => {
    const hoveredEl = screenshotRef.current?.getHoveredElement();
    if (hoveredEl) {
      setBlockList((prev) => [...prev, hoveredEl.selector]);
    }
  };

  // This popup opens on top of another dialog. Left mounted after closing, its
  // Radix layer stayed the top one with pointer-events enabled, which left the
  // dialog underneath inert — the user could not click Save any more. Mounting
  // it only while open removes the layer with it. (A lone dialog unmounts fine;
  // the stuck layer is specific to opening one dialog over another.)
  if (!disclosure.open) return null;

  return (
    <Dialog open>
      <DialogContent className="overflow-hidden md:max-w-[calc(100vw-4rem)]">
        <DialogHeader>
          <DialogTitle>Pick Content Selector</DialogTitle>
          <DialogDescription>
            Click elements to add them to the selection, click again to remove.
            Content is extracted from every selected block, in page order.
          </DialogDescription>
        </DialogHeader>

        <ContextMenu>
          <ContextMenuTrigger className="h-[calc(90vh-200px)] overflow-hidden">
            <ScreenshotViewer
              ref={screenshotRef}
              screenshot={pageData?.screenshot}
              elements={pageData?.elements}
              selectedSelectors={curSelectors}
              pageSize={pageData?.pageSize}
              isSelecting={
                disclosure.open && !isPending && pageData?.screenshot != null
              }
              onSelect={(el) =>
                setSelectors((prev) =>
                  prev.includes(el.selector)
                    ? prev.filter((s) => s !== el.selector)
                    : [...prev, el.selector],
                )
              }
              disableDepthSelect
            />
          </ContextMenuTrigger>

          <ContextMenuContent>
            <ContextMenuItem onClick={onAddBlockList}>
              Block Element
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {curSelectors.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {curSelectors.map((selector) => (
              <button
                key={selector}
                type="button"
                title="Remove"
                className="bg-muted hover:bg-muted/70 flex items-center gap-1 rounded px-2 py-1 font-mono text-xs"
                onClick={() =>
                  setSelectors((prev) => prev.filter((s) => s !== selector))
                }
              >
                {selector}
                <XIcon className="size-3" />
              </button>
            ))}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            disabled={curSelectors.length === 0}
            onClick={() => setSelectors([])}
          >
            Clear all
          </Button>
          <Button
            disabled={curSelectors.length === 0}
            onClick={() => {
              onSelect?.(curSelectors);
              customSelectorModal.setOpen(false);
            }}
          >
            {curSelectors.length > 1
              ? `Select ${curSelectors.length} blocks`
              : "Select"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
