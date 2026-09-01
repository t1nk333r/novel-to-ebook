import { cn } from "@/lib/utils";
import type { BookDoc, BookRelocate } from "../lib/types";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, PinIcon, PinOffIcon } from "lucide-react";
import { useStore } from "zustand";
import { sidebarStore } from "../lib/stores";
import { useEffect, useRef } from "react";
import { useReaderTheme } from "../lib/hooks";
import BackButton from "@/components/ui/back-button";
import { useSearchParams } from "react-router";
import { $api, API_URL } from "@/lib/api";
import OfflineImage from "@/components/offline-image";

type Props = {
  book?: BookDoc | null;
  curState?: BookRelocate | null;
  onTocClick?: (href: string) => void;
};

export default function Sidebar({ book, curState, onTocClick }: Props) {
  const sidebarRef = useRef<HTMLDivElement>(null!);
  const isHoverRef = useRef(false);
  const { isVisible, isSticky } = useStore(sidebarStore);
  const readerTheme = useReaderTheme();
  const [searchParams] = useSearchParams();
  const bookKey = searchParams.get("book");

  const { data: details } = $api.useQuery("get", "/library/detail", {
    params: { query: { key: bookKey || "" } },
  });

  useEffect(() => {
    // show sidebar on hover left side
    const onMouseMove = (e: MouseEvent) => {
      if (e.clientY < 100 || e.clientY > window.innerHeight - 100) return;

      if (e.clientX < Math.max(window.innerWidth * 0.05, 80)) {
        sidebarStore.setState({ isVisible: true });
        isHoverRef.current = true;
      } else if (
        isHoverRef.current &&
        !sidebarRef.current.contains(e.target as Node)
      ) {
        sidebarStore.setState({ isVisible: false });
        isHoverRef.current = false;
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  return (
    <>
      {isVisible && !isSticky ? (
        <div
          role="button"
          className="fixed top-0 left-0 w-full h-full z-9"
          onClick={() => sidebarStore.setState({ isVisible: false })}
        />
      ) : null}
      <aside
        ref={sidebarRef}
        className={cn(
          "w-[80%] max-w-4/5 sm:max-w-3/5 md:max-w-60 pr-4 bg-sidebar fixed z-10 h-full transition-transform -translate-x-full",
          isSticky && "relative",
          isVisible || isSticky ? "translate-x-0" : "",
        )}
      >
        <div
          className="bg-background w-4 h-full rounded-l-full absolute top-0 right-0 z-1"
          style={{
            background: readerTheme.background,
            color: readerTheme.color,
          }}
        ></div>

        <div className="w-full h-full flex flex-col items-stretch">
          <div className="flex items-center justify-between p-1 pb-0">
            <BackButton to="/" variant="ghost" size="icon-sm">
              <ArrowLeftIcon />
            </BackButton>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => sidebarStore.setState({ isSticky: !isSticky })}
            >
              {isSticky ? <PinIcon /> : <PinOffIcon />}
            </Button>
          </div>

          <div className="flex items-center gap-2 p-3">
            {details?.cover ? (
              <OfflineImage
                src={API_URL + details?.cover}
                className="w-12 aspect-3/4 object-cover mx-auto rounded shrink-0"
              />
            ) : null}
            <div className="flex-1">
              <p className="text-xs font-medium line-clamp-3">
                {String(details?.metadata?.title || "")}
              </p>
              <p className="text-xs mt-0.5 text-muted-foreground">
                {String(
                  details?.metadata?.author ||
                    details?.metadata?.creator ||
                    details?.metadata?.publisher ||
                    "",
                )}
              </p>
            </div>
          </div>

          <div className="p-1 pt-0 overflow-y-auto flex-1">
            {book?.toc?.map((item) => (
              <Button
                key={item.href}
                variant={
                  curState?.tocItem?.href === item.href ? "secondary" : "ghost"
                }
                title={item.label}
                className="w-full text-left justify-start px-2 h-8 text-xs font-normal"
                onClick={() => onTocClick?.(item.href)}
              >
                <span className="truncate">{item.label}</span>
              </Button>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
