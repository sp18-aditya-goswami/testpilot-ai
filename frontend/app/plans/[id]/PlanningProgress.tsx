"use client";

import { useEffect, useState } from "react";
import type { TestPlan } from "@/lib/api";
import styles from "./plan.module.css";

/** Live view of a plan Claude is still building: the steps so far, newest last, and the time spent. */
export function PlanningProgress({ plan, since }: { plan: TestPlan; since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = Math.max(0, Math.round((now - since) / 1000));
  const lines = plan.progress.length > 0 ? plan.progress : ["Starting the planner"];

  return (
    <section className={`panel ${styles.progress}`} aria-labelledby="progress-head" aria-busy="true">
      <div className={styles.progressHead}>
        <h2 id="progress-head">Claude is building the plan</h2>
        <p className={styles.elapsed} aria-live="off">
          <span className="figure">{elapsed}</span> s
        </p>
      </div>
      <ol className={styles.progressList} aria-live="polite">
        {lines.map((line, i) => {
          const current = i === lines.length - 1;
          return (
            <li key={i} className={current ? styles.progressCurrent : undefined}>
              {current ? <span className="spinner keep-motion" aria-hidden="true" /> : <span className={styles.progressDone} aria-hidden="true" />}
              <span>{line}</span>
            </li>
          );
        })}
      </ol>
      <p className={styles.progressNote}>
        Planning runs on the server. You can leave this page and come back; the plan keeps building.
      </p>
    </section>
  );
}
