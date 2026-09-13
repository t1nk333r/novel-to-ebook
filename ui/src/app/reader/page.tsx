import { useEffect, useMemo, useRef, useState } from "react";
import type { BookDoc, BookRelocate, FoliateView } from "./lib/types";
import { useSearchParams } from "react-router";
import {
  getCSS,
  getHistory,
  injectAdditionalLinks,
  saveHistory,
  type ReaderStyles,
} from "./lib/utils";
import { Loader2 } from "lucide-react";
import Sidebar from "./components/sidebar";
import { settingsStore } from "./lib/stores";
import { useStore } from "zustand";
import { isRtl } from "@/lib/language";
import { appStore } from "@/stores/app.store";
import { getBookData } from "@/hooks/use-offline";
import type { OverlayRef } from "./components/overlay";
import Overlay from "./components/overlay";
import Footer from "./components/footer";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  createLoadCoordinator,
  type LoadGeneration,
} from "./lib/reader-load-coordinator";

export default function ReaderPage() {
  const containerRef = useRef<HTMLDivElement>(null!);
  const viewRef = useRef<FoliateView | null>(null);
  const loadCoordinatorRef = useRef(createLoadCoordinator());
  const isRestoredRef = useRef(false);
  const overlayRef = useRef<OverlayRef>(null!);

  const [searchParams] = useSearchParams();
  const bookKey = searchParams.get("book") || "";
  const [curBook, setCurBook] = useState<BookDoc | null>(null);
  const [curState, setCurState] = useState<BookRelocate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const theme = useStore(appStore, (i) => i.theme);
  const settings = useStore(settingsStore);

  const styles = useMemo<ReaderStyles>(
    () => ({
      ...settings.styles,
      colorScheme: theme as never,
    }),
    [theme, settings],
  );

  const onDocLoad = async (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const doc = detail?.doc;
    if (!doc) return;

    injectAdditionalLinks(doc);

    doc.addEventListener("keydown", onKeyDown);
    doc.addEventListener("wheel", onWheel);

    overlayRef.current?.addDocListener(doc);
  };

  const onRelocate = async (e: Event, book: BookDoc) => {
    if (!isRestoredRef.current) return;

    const detail = (e as CustomEvent).detail;
    setCurState(detail);
    saveHistory(bookKey, {
      location: detail,
      name: book?.metadata?.title || bookKey.split("/").pop() || "",
      cover: "/library/cover.jpeg?key=" + encodeURIComponent(bookKey),
    });
  };

  const onWheel = (e: WheelEvent) => {
    const { flow } = settingsStore.getState();
    if (!viewRef.current || flow === "scrolled") return;

    if (e.deltaY < 0) viewRef.current.goLeft();
    else viewRef.current.goRight();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!viewRef.current) return;

    const k = event.key;
    if (k === "ArrowLeft" || k === "ArrowUp") viewRef.current.goLeft();
    else if (k === "ArrowRight" || k === "ArrowDown") viewRef.current.goRight();
  };

  useEffect(() => {
    const container = containerRef.current;
    const loadCoordinator = loadCoordinatorRef.current;

    document.addEventListener("keydown", onKeyDown);
    container?.addEventListener("wheel", onWheel);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      container?.removeEventListener("wheel", onWheel);

      // True unmount: no further load generation will start to close this
      // out, so invalidate any in-flight load and close the installed view
      // ourselves. `viewRef.current` is only ever assigned after its own
      // `open()` has resolved (see `openDoc`), so it is never mid-open here.
      loadCoordinator.dispose();
      if (viewRef.current) {
        viewRef.current.close();
        container?.removeChild(viewRef.current);
        viewRef.current = null;
      }
    };
  }, []);

  // Builds and opens a new Foliate view *detached* from the DOM so opening it
  // never races the currently-installed view's own close/open lifecycle.
  // Only once `view.open()` has fully settled -- and only if `generation` is
  // still current -- does this attach the new view and close/remove the old
  // one. That way `close()` is never called on a view whose own `open()` is
  // still in flight, for either the outgoing or the incoming view.
  const openDoc = async (file: File, generation: LoadGeneration) => {
    // @ts-ignore
    await import("@/lib/foliate-js/view.js");
    if (!generation.isCurrent()) return;

    const view = document.createElement("foliate-view") as FoliateView;
    view.style.width = "100%";
    view.style.height = "100%";
    view.style.display = "block";

    isRestoredRef.current = false;
    await view.open(file as unknown as BookDoc);

    if (!generation.isCurrent()) {
      // A newer key superseded this load while we were opening. Discard this
      // view -- its own `open()` has settled, so closing it now is safe --
      // without ever attaching it or touching the currently active view.
      view.close();
      return;
    }

    if (viewRef.current) {
      viewRef.current.close();
      containerRef.current?.removeChild(viewRef.current);
    }
    viewRef.current = view;
    containerRef.current?.append(view);

    const { book } = view;

    // Paging direction: foliate reads it from the spine's
    // `page-progression-direction`, which our EPUB generator never writes — so an
    // Arabic book would page left-to-right. The language it *does* write says
    // which way the book reads. Set before anything is rendered.
    const languages = (book?.metadata as unknown as { language?: string[] })?.language ?? [];
    if (book && languages.some((value) => isRtl(value))) {
      (book as { dir?: string }).dir = "rtl";
    }

    try {
      console.log("Fetching read progress..");
      const progress = await getHistory(bookKey);
      const lastLocation = progress?.location;

      if (!lastLocation) {
        throw new Error("No read progress found");
      }

      if (!generation.isCurrent()) return;
      view.init({ lastLocation: lastLocation.cfi });
      setCurState(lastLocation);
    } catch (err) {
      if (!generation.isCurrent()) return;
      view.renderer.next();
      setCurState({ fraction: 0 } as never);
      console.error(err);
    } finally {
      setTimeout(() => {
        if (generation.isCurrent()) isRestoredRef.current = true;
      }, 1000);
    }

    if (!generation.isCurrent()) return;

    view.addEventListener("load", onDocLoad);
    view.addEventListener("relocate", (e) => onRelocate(e, book));

    setCurBook(book);
    view.renderer.setStyles?.(getCSS(styles));

    // enable pagination
    view.renderer.setAttribute("flow", settings.flow);
    view.renderer.setAttribute("gap", "2%");
    view.renderer.setAttribute("max-column-count", "2");
    view.renderer.setAttribute("max-inline-size", "920px");

    // enable animation
    view.renderer.setAttribute("animated", "true");

    setIsLoading(false);
  };

  useEffect(() => {
    const generation = loadCoordinatorRef.current.start();
    setIsLoading(true);

    const fetchBook = async () => {
      try {
        const file = await getBookData(bookKey, (file) => {
          if (!generation.isCurrent()) return;
          toast.info("Book file changed!", {
            action: (
              <Button onClick={() => openDoc(file, generation)}>
                Refresh
              </Button>
            ),
          });
        });
        if (!generation.isCurrent()) return;
        if (!file) throw new Error("Cannot find book file!");
        await openDoc(file, generation);
      } catch (err) {
        if (!generation.isCurrent()) return;
        console.error(err);
        toast.error("Failed to load the book. Please try again.");
        setIsLoading(false);
      }
    };

    fetchBook();

    // No cleanup needed here: `start()` already invalidates and aborts the
    // previous generation the moment `bookKey` changes (see
    // `createLoadCoordinator`), so a stale load can never mutate state past
    // that point. True unmount is handled separately below, since no further
    // generation will start there to supersede the active one.
  }, [bookKey]);

  useEffect(() => {
    // update styles
    viewRef.current?.renderer.setStyles?.(getCSS(styles));
  }, [styles]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // reader settings
    view.renderer.setAttribute("flow", settings.flow);
  }, [settings]);

  return (
    <div className="bg-background h-screen-dvh overflow-hidden flex flex-row items-stretch relative">
      {isLoading && (
        <div className="absolute inset-0 bg-background/60 text-foreground w-full h-full z-5 flex flex-col gap-2 items-center justify-center">
          <Loader2 className="animate-spin" size={32} />
          <span>Please wait...</span>
        </div>
      )}

      <Sidebar
        book={curBook}
        curState={curState}
        onTocClick={(href) => viewRef.current?.goTo(href)}
      />

      <div className="flex-1 flex flex-col items-stretch relative">
        <Overlay
          ref={overlayRef}
          curBook={curBook}
          curState={curState}
          containerRef={containerRef}
          viewRef={viewRef}
        />

        <div ref={containerRef} className="flex-1 overflow-hidden" />

        <Footer curBook={curBook} curState={curState} />
      </div>
    </div>
  );
}
