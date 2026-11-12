import Link from "next/link";
import { Icon } from "./Icon";

const STEPS = ["Load the spec", "Review the plan", "Run and read findings"] as const;

/** The three-step flow. `current` is 1-based; earlier steps show as done. `suiteHref` links step 1, `planHref` step 2. */
export function Steps({ current, planHref, suiteHref = "/" }: { current: 1 | 2 | 3; planHref?: string; suiteHref?: string }) {
  return (
    <ol className="steps" aria-label="Progress">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        const body = (
          <>
            <span className="step-num" aria-hidden="true">
              {state === "done" ? <Icon name="check" size={12} /> : n}
            </span>
            <span className="step-label">{label}</span>
          </>
        );
        const href = n === 1 ? suiteHref : n === 2 ? planHref : undefined;
        return (
          <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            {state === "done" && href ? <Link href={href}>{body}</Link> : body}
          </li>
        );
      })}
    </ol>
  );
}
