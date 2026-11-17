import Link from "next/link";
import { Icon } from "./Icon";

export const FLOW_STEPS = ["Your API", "What to test", "Review plan", "Results"] as const;
export type StepNumber = 1 | 2 | 3 | 4;

/**
 * The four-step AI test plan flow. `current` is 1-based; earlier steps show as done and link back when `hrefs` names them.
 */
export function Steps({ current, hrefs = {} }: { current: StepNumber; hrefs?: Partial<Record<StepNumber, string>> }) {
  return (
    <ol className="steps" aria-label="Progress">
      {FLOW_STEPS.map((label, i) => {
        const n = (i + 1) as StepNumber;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        const body = (
          <>
            <span className="step-num" aria-hidden="true">
              {state === "done" ? <Icon name="check" size={12} /> : n}
            </span>
            <span className="step-label">{label}</span>
          </>
        );
        const href = hrefs[n];
        return (
          <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            {state !== "current" && href ? <Link href={href}>{body}</Link> : body}
          </li>
        );
      })}
    </ol>
  );
}
