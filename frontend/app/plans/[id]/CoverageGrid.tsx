"use client";

import { MethodPath } from "@/components/Status";
import type { Category, Source, TestCase } from "@/lib/api";
import styles from "./plan.module.css";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "positive", label: "Positive" },
  { id: "negative", label: "Negative" },
  { id: "boundary", label: "Boundary" },
  { id: "business", label: "Business" },
  { id: "security", label: "Security" },
  { id: "robustness", label: "Robustness" },
];

const SPLIT_LABEL: Record<Source, string> = { ai: "from Claude", contract: "from the contract", fuzz: "from fuzzing", saved: "written by you" };

/** "2 from Claude, 1 from the contract": who made a set of cases. */
export function sourceSplit(cases: TestCase[]): string {
  const order: Source[] = ["ai", "contract", "saved", "fuzz"];
  return order
    .map((s) => [s, cases.filter((c) => c.source === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${SPLIT_LABEL[s]}`)
    .join(", ");
}

export interface CoverageFilter {
  endpoint: string | null;
  category: Category | null;
}

/** Endpoints by category, counted from the plan's cases. Endpoints the strategy named but no case covers stay as visible gaps. */
export function CoverageGrid({
  cases,
  extraEndpoints,
  filter,
  onFilter,
}: {
  cases: TestCase[];
  extraEndpoints: string[];
  filter: CoverageFilter;
  onFilter: (next: CoverageFilter) => void;
}) {
  const endpoints: string[] = [];
  for (const c of cases) if (!endpoints.includes(c.endpoint_id)) endpoints.push(c.endpoint_id);
  for (const e of extraEndpoints) if (!endpoints.includes(e)) endpoints.push(e);

  const matching = (endpoint: string | null, category: Category | null) =>
    cases.filter((c) => (endpoint === null || c.endpoint_id === endpoint) && (category === null || c.category === category));
  const count = (endpoint: string | null, category: Category | null) => matching(endpoint, category).length;

  const isSelected = (endpoint: string | null, category: Category | null) =>
    filter.endpoint === endpoint && filter.category === category && (endpoint !== null || category !== null);

  const toggle = (endpoint: string | null, category: Category | null) =>
    onFilter(isSelected(endpoint, category) ? { endpoint: null, category: null } : { endpoint, category });

  const cell = (endpoint: string | null, category: Category | null, label: string) => {
    const n = count(endpoint, category);
    if (n === 0)
      return (
        <span className={styles.zero} aria-label={`${label}: no cases`}>
          0
        </span>
      );
    return (
      <button
        type="button"
        className={styles.cell}
        aria-pressed={isSelected(endpoint, category)}
        title={sourceSplit(matching(endpoint, category))}
        aria-label={`${label}: ${n} ${n === 1 ? "case" : "cases"}, ${sourceSplit(matching(endpoint, category))}. Show them`}
        onClick={() => toggle(endpoint, category)}
      >
        {n}
      </button>
    );
  };

  return (
    <section className={`panel ${styles.coverage}`} aria-labelledby="coverage-head">
      <div className={styles.coverageHead}>
        <h2 id="coverage-head">Coverage</h2>
        <p>Cases per endpoint and category. Hover a count to see who made them; select it to show only those cases.</p>
      </div>
      <div className="table-scroll">
        <table className={styles.grid}>
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              {CATEGORIES.map((c) => (
                <th key={c.id} scope="col" className={styles.num}>
                  {c.label}
                </th>
              ))}
              <th scope="col" className={styles.num}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((e) => {
              const total = count(e, null);
              return (
                <tr key={e} className={total === 0 ? styles.gapRow : undefined}>
                  <th scope="row">
                    {total > 0 ? (
                      <button
                        type="button"
                        className={styles.rowButton}
                        aria-pressed={isSelected(e, null)}
                        aria-label={`${e}: show all ${total} cases`}
                        onClick={() => toggle(e, null)}
                      >
                        <MethodPath id={e} />
                      </button>
                    ) : (
                      <span className={styles.rowLabel}>
                        <MethodPath id={e} />
                        <span className={styles.gapNote}>No cases yet</span>
                      </span>
                    )}
                  </th>
                  {CATEGORIES.map((c) => (
                    <td key={c.id} className={styles.num}>
                      {cell(e, c.id, `${e}, ${c.label.toLowerCase()}`)}
                    </td>
                  ))}
                  <td className={`${styles.num} ${styles.totalCol}`}>{total}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">All endpoints</th>
              {CATEGORIES.map((c) => (
                <td key={c.id} className={styles.num}>
                  {cell(null, c.id, `Every ${c.label.toLowerCase()} case`)}
                </td>
              ))}
              <td className={`${styles.num} ${styles.totalCol}`}>{cases.length}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
