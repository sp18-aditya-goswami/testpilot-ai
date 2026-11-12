import type { Outcome } from "@/lib/api";
import { Icon, type IconName } from "./Icon";

const OUTCOME: Record<Outcome | "pending", { icon: IconName; label: string }> = {
  passed: { icon: "check", label: "Passed" },
  failed: { icon: "cross", label: "Failed" },
  error: { icon: "alert", label: "Error" },
  skipped: { icon: "minus", label: "Skipped" },
  pending: { icon: "minus", label: "Pending" },
};

export function OutcomeText({ outcome }: { outcome: Outcome | "pending" }) {
  const o = OUTCOME[outcome];
  return (
    <span className={`status status--${outcome}`}>
      <Icon name={o.icon} />
      {o.label}
    </span>
  );
}

export function HttpStatus({ code }: { code: number | null | undefined }) {
  if (code == null) return <span className="http muted">none</span>;
  return <span className={`http http--${String(code)[0]}`}>{code}</span>;
}

export function MethodPath({ id }: { id: string }) {
  const space = id.indexOf(" ");
  const method = space > 0 ? id.slice(0, space) : id;
  const path = space > 0 ? id.slice(space + 1) : "";
  return (
    <span className="mono method-path">
      <span className={`method method--${method.toLowerCase()}`}>{method}</span> {path}
    </span>
  );
}
