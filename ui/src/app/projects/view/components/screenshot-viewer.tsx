import { cn } from "@/lib/utils";
import {
  useRef,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useImperativeHandle,
} from "react";

export type ScreenshotViewerRef = {
  getHoveredElement: () => any | null;
};

type Props = {
  screenshot?: string | null;
  elements?: any[] | null;
  selectedSelector?: string | null;
  selectedSelectors?: string[] | null;
  includeElements?: string[];
  excludeElements?: string[];
  pageSize?: { width: number; height: number } | null;
  isSelecting?: boolean;
  disableDepthSelect?: boolean;
  scale?: number;
  onSelect?: ((el: any) => void) | null;
  ref?: React.RefObject<ScreenshotViewerRef> | null;
};

const ScreenshotViewer = ({
  screenshot,
  elements,
  selectedSelector,
  selectedSelectors,
  includeElements,
  excludeElements,
  pageSize,
  isSelecting,
  onSelect,
  disableDepthSelect = false,
  ref,
  ...props
}: Props) => {
  const containerRef = useRef<HTMLDivElement>(null!);
  const { scale = 1 } = props;
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [hoveredElement, setHoveredElement] = useState<any>(null);
  const [hitsAtCursor, setHitsAtCursor] = useState<any[]>([]);
  const [depthIndex, setDepthIndex] = useState(0);

  const VIEWPORT_W = pageSize?.width || 1280;
  const VIEWPORT_H = pageSize?.height || 720;

  // useEffect(() => {
  //   if (!containerRef.current) return;
  //   const obs = new ResizeObserver(([entry]) => {
  //     const { width, height } = entry.contentRect;
  //     setScale(Math.min(width / VIEWPORT_W, height / VIEWPORT_H));
  //   });
  //   obs.observe(containerRef.current);
  //   return () => obs.disconnect();
  // }, []);

  // Filter elements
  const elementList = useMemo(() => {
    if (!elements) return [];

    if (includeElements && includeElements?.length > 0) {
      return elements.filter((el) => {
        return includeElements.some((include) => {
          if (include.startsWith(".")) {
            return el.attrs?.class?.includes(include.slice(1));
          }
          if (include.startsWith("#")) {
            return el.attrs?.id?.includes(include.slice(1));
          }
          return el.tag === include;
        });
      });
    }

    if (excludeElements && excludeElements?.length > 0) {
      return elements.filter((el) => {
        return !excludeElements.some((exclude) => {
          if (exclude.startsWith(".")) {
            return el.attrs?.class?.includes(exclude.slice(1));
          }
          if (exclude.startsWith("#")) {
            return el.attrs?.id?.includes(exclude.slice(1));
          }
          return el.tag === exclude;
        });
      });
    }

    return elements;
  }, [elements, excludeElements, includeElements]);

  const getElementsAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!containerRef.current) return [];
      const rect = containerRef.current.getBoundingClientRect();
      const x = (clientX - rect.left) / scale;
      const y = (clientY - rect.top) / scale;

      return elementList
        .filter((el) => {
          const { box } = el;
          return (
            x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
          );
        })
        .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h); // smallest first
    },
    [elementList, scale],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (!isSelecting) {
        return;
      }

      const hits = getElementsAtPoint(e.clientX, e.clientY);
      setHitsAtCursor(hits);
      setDepthIndex(0);
      setHoveredElement(hits[0] || null);
      setMousePos({ x: e.clientX, y: e.clientY });
    },
    [isSelecting, getElementsAtPoint, setHoveredElement],
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (!mousePos) {
        return;
      }

      if (mousePos.x !== e.clientX && mousePos.y !== e.clientY) {
        setHoveredElement(null);
        setMousePos(null);
      }
    },
    [setHoveredElement, mousePos],
  );

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!isSelecting || hitsAtCursor.length < 2 || disableDepthSelect) {
        return;
      }

      e.preventDefault();
      setDepthIndex((prev) => {
        const next =
          e.deltaY > 0
            ? Math.min(prev + 1, hitsAtCursor.length - 1)
            : Math.max(prev - 1, 0);
        setHoveredElement(hitsAtCursor[next] || null);
        return next;
      });
    },
    [isSelecting, hitsAtCursor, setHoveredElement, disableDepthSelect],
  );

  const handleClick = useCallback(
    (_e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (!isSelecting) {
        return;
      }

      // const hits = getElementsAtPoint(e.clientX, e.clientY);
      // if (hits[0]) onSelect(hits[0].selector);
      if (hoveredElement && onSelect) {
        onSelect(hoveredElement);
      }
    },
    [isSelecting, onSelect, hoveredElement],
  );

  useEffect(() => {
    containerRef.current?.addEventListener("wheel", handleWheel, {
      passive: false,
    });
    return () =>
      containerRef.current?.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // A list wins when given; the single prop stays for the callers that still
  // pass one, so both flows render through the same rects.
  const activeSelectors = useMemo(
    () => selectedSelectors ?? (selectedSelector ? [selectedSelector] : []),
    [selectedSelectors, selectedSelector],
  );
  const selectedEls = useMemo(
    () => elementList.filter((el) => activeSelectors.includes(el.selector)),
    [elementList, activeSelectors],
  );

  useImperativeHandle(
    ref,
    () => ({
      getHoveredElement: () => hoveredElement,
    }),
    [hoveredElement],
  );

  return (
    <div
      className={cn(
        "w-full h-full bg-slate-200 dark:bg-background",
        screenshot ? "overflow-auto" : "overflow-hidden",
      )}
    >
      <div
        ref={containerRef}
        className={cn(
          "relative shrink-0 mx-auto",
          isSelecting && "cursor-crosshair",
        )}
        style={{
          width: VIEWPORT_W * scale,
          height: VIEWPORT_H * scale,
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        // onWheel={handleWheel}
        {...props}
      >
        {screenshot ? (
          <img
            src={`data:image/jpeg;base64,${screenshot}`}
            alt="Page screenshot"
            draggable={false}
            className="block h-full w-full select-none"
          />
        ) : null}

        {elements && elements.length > 0 && isSelecting && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${VIEWPORT_W} ${VIEWPORT_H}`}
          >
            {hitsAtCursor.map((el, i) => {
              if (i === depthIndex) return null;
              const alpha = Math.max(0.04, 0.3 - i * 0.02);

              return (
                <rect
                  key={i}
                  x={el.box.x}
                  y={el.box.y}
                  width={el.box.w}
                  height={el.box.h}
                  fill="none"
                  stroke={`rgba(0,0,255,${alpha})`}
                  strokeWidth="1"
                  strokeDasharray="3 4"
                />
              );
            })}

            {selectedEls.map((el) => (
              <rect
                key={el.selector}
                x={el.box.x}
                y={el.box.y}
                width={el.box.w}
                height={el.box.h}
                fill="rgba(0,229,255,0.12)"
                stroke="#00e5ff"
                strokeWidth="2"
              />
            ))}

            {hoveredElement && !activeSelectors.includes(hoveredElement.selector) && (
              <rect
                x={hoveredElement.box.x}
                y={hoveredElement.box.y}
                width={hoveredElement.box.w}
                height={hoveredElement.box.h}
                fill="rgba(255,107,107,0.08)"
                stroke="#ff6b6b"
                strokeWidth="1.5"
                strokeDasharray="4 3"
              />
            )}

            {hoveredElement && (
              <g>
                <rect
                  x={hoveredElement.box.x}
                  y={Math.max(0, hoveredElement.box.y - 20)}
                  width={hoveredElement.tag.length * 7 + 16}
                  height={18}
                  fill={
                    activeSelectors.includes(hoveredElement.selector)
                      ? "#00e5ff"
                      : "#ff6b6b"
                  }
                  rx="2"
                />
                <text
                  x={hoveredElement.box.x + 8}
                  y={Math.max(0, hoveredElement.box.y - 20) + 13}
                  fill="#000"
                  fontSize="11"
                  fontFamily="monospace"
                  fontWeight="700"
                >
                  {hoveredElement.tag}
                </text>
              </g>
            )}
          </svg>
        )}

        {isSelecting && hoveredElement && mousePos && (
          <ElementTooltip
            element={hoveredElement}
            mousePos={mousePos}
            containerRef={containerRef}
          />
        )}
      </div>
    </div>
  );
};

export default ScreenshotViewer;

type ElementTooltipProps = {
  element: any;
  mousePos: { x: number; y: number };
  containerRef: React.RefObject<HTMLDivElement>;
};

function ElementTooltip({
  element,
  mousePos,
  containerRef,
}: ElementTooltipProps) {
  const rect = containerRef.current?.getBoundingClientRect();
  if (!rect) return null;

  const x = mousePos.x - rect.left + 12;
  const y = mousePos.y - rect.top + 12;

  return (
    <div
      className="pointer-events-none absolute z-10 max-w-70 rounded-md border bg-background/95 px-3 py-2 backdrop-blur-md"
      style={{
        left: Math.min(x, rect.width - 280),
        top: Math.min(y, rect.height - 80),
        animation: "slide-in 0.1s ease",
      }}
    >
      <div className="mb-1 font-mono text-[10px] text-cyan-400">
        &lt;{element.tag}&gt; · {element.box.w}×{element.box.h}
      </div>

      <div className="max-w-65 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-cyan-400">
        {element.selector}
      </div>

      {element.text && (
        <div className="mt-1 max-w-65 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-zinc-300">
          "{element.text}"
        </div>
      )}
    </div>
  );
}
