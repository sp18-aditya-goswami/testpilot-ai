"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage, type TestPlan } from "@/lib/api";
import { runHref } from "@/app/runs/format";
import styles from "./plan.module.css";

function caseCount(n: number) {
  return `${n} ${n === 1 ? "case" : "cases"}`;
}

export function RunPanel({
  plan,
  selected,
  allowDestructive,
  onAllowDestructive,
}: {
  plan: TestPlan;
  selected: Set<string>;
  allowDestructive: boolean;
  onAllowDestructive: (value: boolean) => void;
}) {
  const router = useRouter();
  const [fuzz, setFuzz] = useState(true);
  const [examples, setExamples] = useState("20");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = plan.cases.length;
  const count = selected.size;
  const destructiveSelected = plan.cases.filter((c) => c.destructive && selected.has(c.id)).length;
  const skippedDestructive = allowDestructive ? 0 : destructiveSelected;
  const runnable = count - skippedDestructive;
  const exampleNumber = Number(examples);
  const examplesValid = Number.isInteger(exampleNumber) && exampleNumber >= 1 && exampleNumber <= 100;

  let destructiveHelp = "DELETE requests are skipped unless this is on.";
  if (allowDestructive) destructiveHelp = `DELETE requests will run against ${plan.base_url}.`;
  else if (destructiveSelected > 0)
    destructiveHelp = `${destructiveSelected} selected DELETE ${destructiveSelected === 1 ? "case is" : "cases are"} skipped while this is off.`;

  let blocked: string | null = null;
  if (count === 0) blocked = "Select at least one case to run.";
  else if (runnable === 0) blocked = "Every selected case is a DELETE. Turn on destructive requests to run them.";
  else if (fuzz && !examplesValid) blocked = "Examples per operation must be a whole number from 1 to 100.";

  async function start() {
    if (blocked || starting) return;
    setStarting(true);
    setError(null);
    try {
      const run = await api.startRun(plan.id, {
        case_ids: count === total ? null : Array.from(selected),
        allow_destructive: allowDestructive,
        fuzz,
        fuzz_examples: fuzz ? exampleNumber : 20,
      });
      router.push(runHref({ id: run.id, spec_title: run.spec_title, project_id: run.project_id ?? plan.project_id }));
    } catch (err) {
      setError(errorMessage(err));
      setStarting(false);
    }
  }

  const helperId = "run-helper";
  return (
    <section className={styles.runPanel} aria-label="Run settings">
      <div className={styles.runInner}>
        <p className={styles.selectedCount}>
          <span className="figure">{count}</span> of {caseCount(total)} selected
        </p>

        <div className={styles.option}>
          <label className="check">
            <input
              type="checkbox"
              name="allow_destructive"
              checked={allowDestructive}
              onChange={(e) => onAllowDestructive(e.target.checked)}
              aria-describedby="destructive-help"
            />
            <span>Run destructive requests (DELETE)</span>
          </label>
          <p id="destructive-help" className="helper">
            {destructiveHelp}
          </p>
        </div>

        <div className={styles.option}>
          <label className="check">
            <input
              type="checkbox"
              name="fuzz"
              checked={fuzz}
              onChange={(e) => setFuzz(e.target.checked)}
              aria-describedby={fuzz ? undefined : "fuzz-help"}
            />
            <span>Fuzz the API with Schemathesis</span>
          </label>
          {fuzz ? (
            <div className={styles.examples}>
              <label htmlFor="fuzz-examples">Examples per operation</label>
              <input
                id="fuzz-examples"
                name="fuzz_examples"
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                value={examples}
                aria-invalid={!examplesValid || undefined}
                onChange={(e) => setExamples(e.target.value)}
              />
            </div>
          ) : (
            <p id="fuzz-help" className="helper">
              Generated inputs from the schema, run after the planned cases.
            </p>
          )}
        </div>

        <div className={styles.runAction}>
          <button
            type="button"
            className="key key--primary"
            onClick={start}
            disabled={blocked !== null}
            aria-busy={starting || undefined}
            aria-describedby={helperId}
          >
            {starting && <span className="spinner keep-motion" aria-hidden="true" />}
            {starting ? "Starting run" : `Run ${caseCount(runnable)}`}
          </button>
          <p id={helperId} className={`helper${error || (blocked && count > 0) ? " is-error" : ""}`} role={error ? "alert" : undefined}>
            {error ?? blocked ?? (fuzz ? "Fuzzing runs once the planned cases finish." : "")}
          </p>
        </div>
      </div>
    </section>
  );
}
