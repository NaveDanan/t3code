"use client";

import { Search } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from "react";

import { cn } from "~/lib/utils";

export interface EffectRendererProps {
  text: string;
  isActive: boolean;
  allowDelete?: boolean;
  typeDurationMs: number;
  deleteDurationMs: number;
  pauseAfterTypeMs: number;
  prefersReducedMotion?: boolean;
  onDeleteComplete?: () => void;
  containerRef?: RefObject<HTMLElement | null>;
}

export type BuiltinEffect = "typewriter" | "slide" | "fade" | "none";

export interface SuggestiveSearchProps {
  onChange?: (value: string) => void;
  suggestions?: string[];
  className?: string;
  Leading?: ComponentType;
  showLeading?: boolean;
  Trailing?: ComponentType;
  showTrailing?: boolean;
  effect?: BuiltinEffect;
  EffectComponent?: ComponentType<EffectRendererProps>;
  typeDurationMs?: number;
  deleteDurationMs?: number;
  pauseAfterTypeMs?: number;
  animateMode?: "infinite" | "once";
  ariaLabel?: string;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

function clearTimers(timers: TimerHandle[]) {
  for (const timer of timers) {
    globalThis.clearTimeout(timer);
  }
  timers.length = 0;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };

    updatePreference();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updatePreference);
      return () => {
        mediaQuery.removeEventListener("change", updatePreference);
      };
    }

    mediaQuery.addListener(updatePreference);
    return () => {
      mediaQuery.removeListener(updatePreference);
    };
  }, []);

  return prefersReducedMotion;
}

export function TypewriterEffect({
  text,
  isActive,
  allowDelete = true,
  typeDurationMs,
  deleteDurationMs,
  pauseAfterTypeMs,
  prefersReducedMotion,
  onDeleteComplete,
  containerRef,
}: EffectRendererProps) {
  const [phase, setPhase] = useState<"typing" | "paused" | "deleting">("typing");
  const timers = useRef<TimerHandle[]>([]);

  useEffect(() => {
    const effectTimers = timers.current;
    setPhase("typing");
    clearTimers(effectTimers);
    return () => {
      clearTimers(effectTimers);
    };
  }, [allowDelete, isActive, text]);

  useEffect(() => {
    const effectTimers = timers.current;
    if (!isActive || !prefersReducedMotion || !allowDelete) {
      return;
    }

    const timer = globalThis.setTimeout(
      () => {
        onDeleteComplete?.();
      },
      Math.max(200, pauseAfterTypeMs),
    );
    effectTimers.push(timer);

    return () => {
      clearTimers(effectTimers);
    };
  }, [allowDelete, isActive, onDeleteComplete, pauseAfterTypeMs, prefersReducedMotion]);

  if (!isActive) {
    return null;
  }

  return (
    <div
      ref={containerRef as RefObject<HTMLDivElement | null> | undefined}
      style={{
        display: "inline-block",
        overflow: "hidden",
        whiteSpace: "nowrap",
      }}
    >
      {prefersReducedMotion ? (
        <span className="select-none text-sm text-muted-foreground">{text}</span>
      ) : (
        <motion.div
          key={text}
          initial={{ width: "0%" }}
          animate={
            phase === "typing"
              ? { width: "100%" }
              : phase === "deleting"
                ? { width: "0%" }
                : { width: "100%" }
          }
          transition={
            phase === "typing"
              ? { duration: typeDurationMs / 1000, ease: "linear" }
              : phase === "deleting"
                ? { duration: deleteDurationMs / 1000, ease: "linear" }
                : {}
          }
          onAnimationComplete={() => {
            if (phase === "typing") {
              setPhase("paused");
              if (!allowDelete) {
                return;
              }
              const timer = globalThis.setTimeout(() => {
                setPhase("deleting");
              }, pauseAfterTypeMs);
              timers.current.push(timer);
              return;
            }

            if (phase === "deleting") {
              onDeleteComplete?.();
            }
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <span className="select-none text-sm text-muted-foreground">{text}</span>
          <motion.span
            aria-hidden
            className="bg-muted-foreground"
            style={{
              display: "inline-block",
              width: 1,
              marginLeft: 4,
              height: "1.1em",
              verticalAlign: "middle",
            }}
            animate={
              phase === "typing" || phase === "paused" ? { opacity: [0, 1, 0] } : { opacity: 0 }
            }
            transition={
              phase === "typing" || phase === "paused"
                ? { repeat: Number.POSITIVE_INFINITY, duration: 0.9, ease: "linear" }
                : { duration: 0.1 }
            }
          />
        </motion.div>
      )}
    </div>
  );
}

export function SlideEffect({
  text,
  isActive,
  allowDelete = true,
  typeDurationMs,
  deleteDurationMs,
  pauseAfterTypeMs,
  prefersReducedMotion,
  onDeleteComplete,
  containerRef,
}: EffectRendererProps) {
  const [phase, setPhase] = useState<"enter" | "pause" | "exit">("enter");
  const timers = useRef<TimerHandle[]>([]);

  useEffect(() => {
    const effectTimers = timers.current;
    setPhase("enter");
    clearTimers(effectTimers);
    return () => {
      clearTimers(effectTimers);
    };
  }, [allowDelete, isActive, text]);

  useEffect(() => {
    const effectTimers = timers.current;
    if (!isActive || !prefersReducedMotion || !allowDelete) {
      return;
    }

    const timer = globalThis.setTimeout(
      () => {
        onDeleteComplete?.();
      },
      Math.max(200, pauseAfterTypeMs),
    );
    effectTimers.push(timer);

    return () => {
      clearTimers(effectTimers);
    };
  }, [allowDelete, isActive, onDeleteComplete, pauseAfterTypeMs, prefersReducedMotion]);

  if (!isActive) {
    return null;
  }

  if (prefersReducedMotion) {
    return <span className="select-none text-sm text-muted-foreground">{text}</span>;
  }

  return (
    <div
      ref={containerRef as RefObject<HTMLDivElement | null> | undefined}
      style={{
        overflow: "hidden",
        display: "inline-block",
        whiteSpace: "nowrap",
      }}
    >
      <motion.div
        key={text}
        initial={{ y: "-100%" }}
        animate={phase === "enter" ? { y: "0%" } : phase === "exit" ? { y: "100%" } : { y: "0%" }}
        transition={
          phase === "enter"
            ? { duration: typeDurationMs / 1000, ease: "easeOut" }
            : { duration: deleteDurationMs / 1000, ease: "easeIn" }
        }
        onAnimationComplete={() => {
          if (phase === "enter") {
            setPhase("pause");
            if (!allowDelete) {
              return;
            }
            const timer = globalThis.setTimeout(() => {
              setPhase("exit");
            }, pauseAfterTypeMs);
            timers.current.push(timer);
            return;
          }

          if (phase === "exit") {
            onDeleteComplete?.();
          }
        }}
        style={{ display: "inline-block" }}
      >
        <span className="select-none text-sm text-muted-foreground">{text}</span>
      </motion.div>
    </div>
  );
}

export function FadeEffect({
  text,
  isActive,
  allowDelete = true,
  typeDurationMs,
  deleteDurationMs,
  pauseAfterTypeMs,
  prefersReducedMotion,
  onDeleteComplete,
  containerRef,
}: EffectRendererProps) {
  const [phase, setPhase] = useState<"fadeIn" | "hold" | "fadeOut">("fadeIn");
  const timers = useRef<TimerHandle[]>([]);

  useEffect(() => {
    const effectTimers = timers.current;
    setPhase("fadeIn");
    clearTimers(effectTimers);
    return () => {
      clearTimers(effectTimers);
    };
  }, [allowDelete, isActive, text]);

  useEffect(() => {
    const effectTimers = timers.current;
    if (!isActive || !prefersReducedMotion || !allowDelete) {
      return;
    }

    const timer = globalThis.setTimeout(
      () => {
        onDeleteComplete?.();
      },
      Math.max(200, pauseAfterTypeMs),
    );
    effectTimers.push(timer);

    return () => {
      clearTimers(effectTimers);
    };
  }, [allowDelete, isActive, onDeleteComplete, pauseAfterTypeMs, prefersReducedMotion]);

  if (!isActive) {
    return null;
  }

  if (prefersReducedMotion) {
    return <span className="select-none text-sm text-muted-foreground">{text}</span>;
  }

  return (
    <div
      ref={containerRef as RefObject<HTMLDivElement | null> | undefined}
      style={{
        overflow: "hidden",
        display: "inline-block",
        whiteSpace: "nowrap",
      }}
    >
      <motion.div
        key={text}
        initial={{ opacity: 0 }}
        animate={
          phase === "fadeIn"
            ? { opacity: 1 }
            : phase === "fadeOut"
              ? { opacity: 0 }
              : { opacity: 1 }
        }
        transition={
          phase === "fadeIn"
            ? { duration: typeDurationMs / 1000 }
            : { duration: deleteDurationMs / 1000 }
        }
        onAnimationComplete={() => {
          if (phase === "fadeIn") {
            setPhase("hold");
            if (!allowDelete) {
              return;
            }
            const timer = globalThis.setTimeout(() => {
              setPhase("fadeOut");
            }, pauseAfterTypeMs);
            timers.current.push(timer);
            return;
          }

          if (phase === "fadeOut") {
            onDeleteComplete?.();
          }
        }}
        style={{ display: "inline-block" }}
      >
        <span className="select-none text-sm text-muted-foreground">{text}</span>
      </motion.div>
    </div>
  );
}

function NoEffect() {
  return null;
}

export function SuggestiveSearch({
  onChange,
  suggestions = ["Search providers"],
  className,
  Leading = () => <Search className="size-4 text-muted-foreground" />,
  showLeading = true,
  Trailing = () => <Search className="size-4 text-muted-foreground" />,
  showTrailing = false,
  effect = "typewriter",
  EffectComponent,
  typeDurationMs = 500,
  deleteDurationMs = 300,
  pauseAfterTypeMs = 1500,
  animateMode = "infinite",
  ariaLabel = "Search",
}: SuggestiveSearchProps) {
  const [search, setSearch] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [index, setIndex] = useState(0);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const leadingRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trailingRef = useRef<HTMLDivElement | null>(null);

  const [leftOffsetPx, setLeftOffsetPx] = useState<number | null>(null);
  const [rightOffsetPx, setRightOffsetPx] = useState<number | null>(null);
  const [measuredLongestTextPx, setMeasuredLongestTextPx] = useState<number | null>(null);
  const [availableTextAreaPx, setAvailableTextAreaPx] = useState<number | null>(null);

  const normalizedSuggestions = useMemo(
    () =>
      suggestions
        .map((suggestion) => suggestion.trim())
        .filter((suggestion) => suggestion.length > 0),
    [suggestions],
  );
  const longestSuggestion = useMemo(
    () =>
      normalizedSuggestions.reduce((longest, suggestion) => {
        return suggestion.length > longest.length ? suggestion : longest;
      }, ""),
    [normalizedSuggestions],
  );
  const current = useMemo(() => normalizedSuggestions[index] ?? "", [index, normalizedSuggestions]);

  useEffect(() => {
    if (index < normalizedSuggestions.length) {
      return;
    }
    setIndex(0);
  }, [index, normalizedSuggestions.length]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const leading = leadingRef.current;
    const trailing = trailingRef.current;
    if (!wrapper) {
      return;
    }

    const updateMeasurements = () => {
      const computedStyles = window.getComputedStyle(wrapper);
      const paddingLeft = Number.parseFloat(computedStyles.paddingLeft || "0");
      const paddingRight = Number.parseFloat(computedStyles.paddingRight || "0");
      const leadingWidth = showLeading ? (leading?.getBoundingClientRect().width ?? 0) : 0;
      const trailingWidth = showTrailing ? (trailing?.getBoundingClientRect().width ?? 0) : 0;
      const leftOffset = paddingLeft + leadingWidth + 8;
      const rightOffset = paddingRight + trailingWidth;

      setLeftOffsetPx(leftOffset);
      setRightOffsetPx(rightOffset);

      const wrapperWidth = wrapper.getBoundingClientRect().width;
      setAvailableTextAreaPx(Math.max(0, wrapperWidth - leftOffset - rightOffset));
    };

    updateMeasurements();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateMeasurements);
    resizeObserver.observe(wrapper);
    if (leading) {
      resizeObserver.observe(leading);
    }
    if (trailing) {
      resizeObserver.observe(trailing);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [showLeading, showTrailing]);

  useEffect(() => {
    if (!longestSuggestion) {
      setMeasuredLongestTextPx(null);
      return;
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      setMeasuredLongestTextPx(null);
      return;
    }

    const fontSource = inputRef.current ?? wrapperRef.current;
    if (!fontSource) {
      context.font = "14px system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial";
    } else {
      const computedStyles = window.getComputedStyle(fontSource);
      context.font = `${computedStyles.fontStyle} ${computedStyles.fontVariant} ${computedStyles.fontWeight} ${computedStyles.fontSize} / ${computedStyles.lineHeight} ${computedStyles.fontFamily}`;
    }

    setMeasuredLongestTextPx(Math.ceil(context.measureText(longestSuggestion).width) + 8);
  }, [longestSuggestion]);

  const builtinMap: Record<BuiltinEffect, ComponentType<EffectRendererProps>> = {
    typewriter: TypewriterEffect,
    slide: SlideEffect,
    fade: FadeEffect,
    none: NoEffect,
  };
  const ChosenEffect = EffectComponent ?? builtinMap[effect];
  const prefersReducedMotion = usePrefersReducedMotion();

  const minWidthPx =
    measuredLongestTextPx != null && availableTextAreaPx != null
      ? Math.min(measuredLongestTextPx, availableTextAreaPx)
      : (measuredLongestTextPx ?? undefined);
  const overlayActive = !search && !isFocused && current.length > 0;
  const isLastSuggestion =
    normalizedSuggestions.length > 0 && index === normalizedSuggestions.length - 1;
  const allowDelete =
    normalizedSuggestions.length > 1 && (animateMode === "infinite" || !isLastSuggestion);

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative flex max-w-full items-center gap-x-2 rounded-full border border-border bg-background px-4 py-2",
        className,
      )}
    >
      <div ref={leadingRef} className="flex shrink-0 items-center">
        {showLeading ? <Leading /> : null}
      </div>

      <input
        ref={inputRef}
        type="text"
        value={search}
        onBlur={() => setIsFocused(false)}
        onChange={(event) => {
          const nextValue = event.target.value;
          setSearch(nextValue);
          onChange?.(nextValue);
        }}
        onFocus={() => setIsFocused(true)}
        className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-transparent"
        placeholder=""
        aria-label={ariaLabel}
        style={minWidthPx != null ? { minWidth: `${minWidthPx}px` } : undefined}
      />

      <div ref={trailingRef} className="flex shrink-0 items-center">
        {showTrailing ? <Trailing /> : null}
      </div>

      {overlayActive ? (
        <div
          ref={overlayRef}
          aria-hidden
          style={{
            position: "absolute",
            left: leftOffsetPx != null ? `${leftOffsetPx}px` : "calc(0.5rem + 1.5rem + 8px)",
            right: rightOffsetPx != null ? `${rightOffsetPx}px` : "0.5rem",
            top: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            pointerEvents: "none",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <ChosenEffect
            text={current}
            isActive={overlayActive}
            allowDelete={allowDelete}
            typeDurationMs={typeDurationMs}
            deleteDurationMs={deleteDurationMs}
            pauseAfterTypeMs={pauseAfterTypeMs}
            prefersReducedMotion={prefersReducedMotion}
            onDeleteComplete={() => {
              if (normalizedSuggestions.length < 2) {
                return;
              }
              setIndex((currentIndex) => (currentIndex + 1) % normalizedSuggestions.length);
            }}
            containerRef={overlayRef}
          />
        </div>
      ) : null}
    </div>
  );
}

export default SuggestiveSearch;
