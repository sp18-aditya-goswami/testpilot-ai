"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { PlanResult, planRowHref } from "@/components/PlanResult";
import { errorMessage } from "@/lib/api";
import { flowHref, testPlans, type TestPlanRow } from "@/lib/testplans";
import { formatStarted } from "../runs/format";
import styles from "./plans-list.module.css";

export default function TestPlansPage() {
  const router = useRouter();
  const [rows, setRows] = useState<TestPlanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await testPlans.list());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Test plans</h1>
          <p>Every plan you have built, with its latest result. Open one to read the report, run it again or change what it tests.</p>
        </div>
        {rows && rows.length > 0 && (
          <Link href={flowHref.start} className="key key--primary">
            <Icon name="plus" />
            New test plan
          </Link>
        )}
      </div>

      {error ? (
        <div className="error-state" role="alert">
          <h3>Test plans could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="key" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : !rows ? (
        <div className={styles.skeleton} aria-busy="true" aria-label="Loading test plans">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : rows.length === 0 ? (
        <div className={`empty ${styles.empty}`}>
          <h3>No test plans yet</h3>
          <p>Point TestPilot at an OpenAPI spec and the server to test. AI plans the cases, you review them, TestPilot runs them and reports what failed.</p>
          <Link href={flowHref.start} className="key key--primary">
            Start a test plan
            <Icon name="arrowRight" />
          </Link>
        </div>
      ) : (
        <div className="table-scroll panel">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Project</th>
                <th scope="col" className="num">
                  Cases
                </th>
                <th scope="col">Latest result</th>
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const href = planRowHref(r);
                return (
                  <tr key={r.suite_item_id} className="is-link" onClick={() => router.push(href)}>
                    <td>
                      <Link href={href} className={styles.name} onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Link>
                      {r.spec_title && <span className={styles.api}>{r.spec_title}</span>}
                    </td>
                    <td>{r.project_name}</td>
                    <td className="num">
                      {r.last_plan_id ? (
                        <>
                          {r.case_count}
                          {r.ai_case_count > 0 && <span className={styles.ai}> ({r.ai_case_count} by AI)</span>}
                        </>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td>
                      <PlanResult row={r} />
                    </td>
                    <td className="nowrap muted">{formatStarted(r.last_run?.created_at ?? r.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
