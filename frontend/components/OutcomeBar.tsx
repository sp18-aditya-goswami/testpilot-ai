import type { RunCounts } from "@/lib/api";

const SEGMENTS = [
  { key: "passed", label: "passed" },
  { key: "failed", label: "failed" },
  { key: "error", label: "errors" },
  { key: "skipped", label: "skipped" },
] as const;

/** Real counts drawn as one stacked bar, with the numbers spelled out beside it. */
export function OutcomeBar({ counts, legend = true }: { counts: RunCounts; legend?: boolean }) {
  const total = Math.max(counts.total, 1);
  const summary = SEGMENTS.filter((s) => counts[s.key] > 0)
    .map((s) => `${counts[s.key]} ${s.label}`)
    .join(", ");
  return (
    <div>
      <div className="outcome-bar" role="img" aria-label={summary || "No results yet"}>
        {SEGMENTS.map((s) =>
          counts[s.key] > 0 ? (
            <span key={s.key} className={`seg-${s.key}`} style={{ flexGrow: counts[s.key], flexBasis: `${(counts[s.key] / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      {legend && (
        <p className="outcome-legend">
          {SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
            <span key={s.key} className={`status status--${s.key === "error" ? "error" : s.key}`}>
              <b>{counts[s.key]}</b> {s.label}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
