import type { Source } from "@/lib/api";
import { Icon, type IconName } from "./Icon";

export interface SourceInfo {
  label: string;
  group: "AI-generated" | "System-generated" | "You";
  icon: IconName;
  meaning: string;
}

export const SOURCES: Record<Source, SourceInfo> = {
  ai: {
    label: "Claude",
    group: "AI-generated",
    icon: "spark",
    meaning: "Claude proposed it from your instructions, rules and the spec. TestPilot validated it before it could run.",
  },
  contract: {
    label: "Contract",
    group: "System-generated",
    icon: "schema",
    meaning: "TestPilot derived it from the OpenAPI schema: required fields, types, bounds and documented status codes.",
  },
  fuzz: {
    label: "Fuzzing",
    group: "System-generated",
    icon: "dice",
    meaning: "Schemathesis generated the input from the schema. Only requests that broke a check are kept.",
  },
  saved: {
    label: "Written by you",
    group: "You",
    icon: "pencil",
    meaning: "A request saved in a collection, or a case added by hand to the plan.",
  },
};

/** Who made a case. Text plus one icon; Claude's cases carry the AI colour. */
export function SourceTag({ source, withGroup = false }: { source: Source; withGroup?: boolean }) {
  const s = SOURCES[source];
  return (
    <span className={`src src--${source}`} title={s.meaning}>
      <Icon name={s.icon} />
      <span>
        {s.label}
        {withGroup && s.group !== "You" && <span className="src-group">, {s.group.toLowerCase()}</span>}
      </span>
    </span>
  );
}

/** Who explained a failure. */
export function ExplainedBy({ source }: { source: "ai" | "rules" }) {
  return source === "ai" ? (
    <span className="src src--ai">
      <Icon name="spark" />
      Explained by Claude
    </span>
  ) : (
    <span className="src src--contract">
      <Icon name="schema" />
      Explained by TestPilot rules
    </span>
  );
}

/** The one place the three kinds of origin are spelled out. Pass counts to show how many of each a plan or run holds. */
export function SourceLegend({ counts }: { counts?: Partial<Record<Source, number>> }) {
  const order: Source[] = ["ai", "contract", "fuzz", "saved"];
  const shown = counts ? order.filter((k) => (counts[k] ?? 0) > 0) : order;
  return (
    <dl className="src-legend">
      {shown.map((k) => (
        <div key={k}>
          <dt>
            <SourceTag source={k} />
            {counts && <b className="num">{counts[k]}</b>}
          </dt>
          <dd>
            <span className="src-legend-group">{SOURCES[k].group}.</span> {SOURCES[k].meaning}
          </dd>
        </div>
      ))}
    </dl>
  );
}
