"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { PlanResult, planRowHref } from "@/components/PlanResult";
import { api, type Health } from "@/lib/api";
import { flowHref, testPlans, type TestPlanRow } from "@/lib/testplans";
import { formatStarted } from "./runs/format";
import styles from "./landing.module.css";

const FLOW = ["Your API", "What to test", "Review plan", "Results"];

export default function Landing() {
  const [plans, setPlans] = useState<TestPlanRow[] | null | "error">(null);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    testPlans.list().then(setPlans, () => setPlans("error"));
    api.health().then(setHealth, () => setHealth(null));
  }, []);

  const recent = Array.isArray(plans) ? plans.slice(0, 4) : [];

  return (
    <>
      <section className={styles.hero} aria-labelledby="landing-title">
        <h1 id="landing-title" className={styles.title}>
          Test an API without writing the tests.
        </h1>
        <p className={styles.lead}>AI plans the tests. Code runs them and decides pass or fail.</p>
      </section>

      <div className={styles.doors}>
        <section className={`${styles.door} ${styles.doorMain}`} aria-labelledby="door-plan">
          <span className={styles.doorIcon} aria-hidden="true">
            <Icon name="spark" size={18} />
          </span>
          <h2 id="door-plan" className={styles.doorTitle}>
            Build an AI test plan
          </h2>
          <p className={styles.doorText}>Give it your OpenAPI spec and business rules. Four short steps to a readable report.</p>
          <ol className={styles.flow} aria-label="The four steps">
            {FLOW.map((s, i) => (
              <li key={s}>
                <span className={styles.flowNum}>{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <div className={styles.doorActions}>
            <Link href={flowHref.start} className="key key--primary">
              Start a test plan
              <Icon name="arrowRight" />
            </Link>
          </div>
        </section>

        <section className={styles.door} aria-labelledby="door-workspace">
          <span className={styles.doorIcon} aria-hidden="true">
            <Icon name="layers" size={18} />
          </span>
          <h2 id="door-workspace" className={styles.doorTitle}>
            Send requests by hand
          </h2>
          <p className={styles.doorText}>Collections, folders, saved requests and environments, the way you use Postman.</p>
          <div className={styles.doorActions}>
            <Link href="/workspace" className="key">
              Open the workspace
            </Link>
          </div>
        </section>
      </div>

      {health && !health.ai_enabled && (
        <p className={`notice ${styles.notice}`}>
          <Icon name="alert" />
          <span>
            AI is off, so plans hold only schema and fuzzing cases. <Link href="/settings">Choose an AI provider in Settings</Link> to add AI-planned cases and explanations.
          </span>
        </p>
      )}

      <section className={styles.recent} aria-labelledby="recent-title">
        <div className={styles.recentHead}>
          <h2 id="recent-title">Recent test plans</h2>
          {recent.length > 0 && (
            <Link href={flowHref.list} className="key key--plain">
              All test plans
              <Icon name="chevron" />
            </Link>
          )}
        </div>
        {plans === "error" ? (
          <p className="muted small">Recent plans could not be loaded. Is the backend running on port 8001?</p>
        ) : plans === null ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading recent plans">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : recent.length === 0 ? (
          <p className={styles.emptyLine}>Plans you build show up here with their latest result.</p>
        ) : (
          <ul className={`panel ${styles.list}`}>
            {recent.map((r) => (
              <li key={r.suite_item_id}>
                <Link href={planRowHref(r)} className={styles.row}>
                  <span className={styles.rowName}>
                    <span className={styles.rowTitle}>{r.name}</span>
                    <span className={styles.rowMeta}>{r.spec_title || r.project_name}</span>
                  </span>
                  <PlanResult row={r} />
                  <span className={styles.rowTime}>{formatStarted(r.last_run?.created_at ?? r.updated_at)}</span>
                  <Icon name="chevron" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.how} aria-labelledby="how-title">
        <h2 id="how-title">Who does what</h2>
        <ol className={styles.howList}>
          <li>
            <h3>
              <span className="src src--ai">
                <Icon name="spark" />
                AI plans
              </span>
            </h3>
            <p>Reads the spec and your rules, then proposes cases endpoint by endpoint. You review them before anything runs.</p>
          </li>
          <li>
            <h3>
              <span className="src">
                <Icon name="check" />
                Code judges
              </span>
            </h3>
            <p>TestPilot sends every request and checks status, schema and timing. The AI never decides pass or fail.</p>
          </li>
          <li>
            <h3>
              <span className="src src--ai">
                <Icon name="spark" />
                AI explains
              </span>
            </h3>
            <p>Each failure gets a likely cause and where to look first, marked as written by AI.</p>
          </li>
        </ol>
      </section>
    </>
  );
}
