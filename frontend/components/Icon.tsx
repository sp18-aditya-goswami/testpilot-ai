const PATHS = {
  check: "M3.5 8.5 6.5 11.5 12.5 4.5",
  cross: "M4.5 4.5 11.5 11.5 M11.5 4.5 4.5 11.5",
  alert: "M8 3v6 M8 11.5v.5",
  minus: "M4 8h8",
  copy: "M5.5 5.5V3.5h7v7h-2 M3.5 5.5h7v7h-7z",
  download: "M8 2.5v8 M4.5 7 8 10.5 11.5 7 M3 13.5h10",
  arrowRight: "M3 8h10 M9 4l4 4-4 4",
  chevron: "M6 4l4 4-4 4",
  external: "M9 3h4v4 M13 3 7.5 8.5 M11 9.5V13H3V5h3.5",
  spark: "M8 2.5v3 M8 10.5v3 M2.5 8h3 M10.5 8h3",
  sun: "M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z M8 1.5v1.5 M8 13v1.5 M1.5 8H3 M13 8h1.5 M3.4 3.4l1 1 M11.6 11.6l1 1 M3.4 12.6l1-1 M11.6 4.4l1-1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z",
  monitor: "M2.5 3.5h11v7h-11z M6 13.5h4 M8 10.5v3",
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  plus: "M8 3.5v9 M3.5 8h9",
  play: "M5 3.5l7 4.5-7 4.5z",
  more: "M4 8h.01 M8 8h.01 M12 8h.01",
  trash: "M3.5 4.5h9 M6.5 4.5V3h3v1.5 M4.5 4.5l.7 8.5h5.6l.7-8.5",
  pencil: "M10.5 3l2.5 2.5-7 7H3.5V10z",
  settings: "M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.4 3.4l1.4 1.4 M11.2 11.2l1.4 1.4 M3.4 12.6l1.4-1.4 M11.2 4.8l1.4-1.4",
  layers: "M8 2.5l5.5 3-5.5 3-5.5-3z M2.5 8.5l5.5 3 5.5-3",
  request: "M3 4.5h10 M3 8h10 M3 11.5h6",
  suite: "M3.5 3.5h9v9h-9z M5.5 7l1.5 1.5L10.5 5",
  schema: "M2.5 3.5h11v9h-11z M2.5 6.5h11 M6.5 6.5v6",
  dice: "M3 3h10v10H3z M5.8 5.8h.01 M10.2 10.2h.01 M8 8h.01",
  spec: "M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12 M6 8h4 M6 10.5h4",
  history: "M8 4.5V8l2.5 1.5 M2.8 8a5.2 5.2 0 1 0 1.5-3.7 M2.5 2.8v2.5H5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
