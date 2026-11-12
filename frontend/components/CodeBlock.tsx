"use client";

import { useState } from "react";
import type { Json } from "@/lib/api";
import { Icon } from "./Icon";

export function formatBody(value: Json | undefined): string {
  if (value === undefined || value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="key key--plain"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      <Icon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ title, code, copy = false }: { title?: string; code: string; copy?: boolean }) {
  return (
    <figure className="graphite" style={{ margin: 0, minWidth: 0 }}>
      {(title || copy) && (
        <figcaption
          className="row"
          style={{
            justifyContent: "space-between",
            padding: "var(--space-2xs) var(--space-2xs) var(--space-2xs) var(--space-md)",
            background: "var(--color-graphite-2)",
            borderRadius: "var(--radius-card) var(--radius-card) 0 0",
          }}
        >
          <span className="mono muted">{title}</span>
          {copy && <CopyButton text={code} />}
        </figcaption>
      )}
      <pre className="code">{code}</pre>
    </figure>
  );
}
