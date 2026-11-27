import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface Props<T extends string> {
  options: ReadonlyArray<readonly [T, ReactNode]>;
  value: T;
  onChange: (value: T) => void;
  variant?: "pill" | "tabs";
  small?: boolean;
  label?: string;
}

export function Segmented<T extends string>({ options, value, onChange, variant = "pill", small, label }: Props<T>) {
  const box = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [ready, setReady] = useState(false);
  const tabs = variant === "tabs";

  useLayoutEffect(() => {
    if (!tabs) return;
    const measure = () => {
      const active = box.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(value)}"]`);
      if (active) setThumb({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [value, options, tabs]);

  useLayoutEffect(() => {
    if (!thumb || ready) return;
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [thumb, ready]);

  return (
    <div ref={box} role="tablist" aria-label={label} className={`seg seg-${variant}${small ? " small" : ""}${ready ? " ready" : ""}`}>
      {tabs && thumb && <span className="seg-thumb" style={{ transform: `translateX(${thumb.left}px) scaleX(${thumb.width})` }} />}
      {options.map(([key, text]) => (
        <button
          key={key}
          data-value={key}
          role="tab"
          aria-selected={value === key}
          className={value === key ? "on" : ""}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
