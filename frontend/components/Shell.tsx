"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Health } from "@/lib/api";
import { Wordmark } from "./Logo";
import { ThemeSwitch } from "./ThemeSwitch";

const LINKS = [
  { href: "/", label: "Projects", match: (p: string) => p === "/" || p.startsWith("/p/") },
  { href: "/settings", label: "Settings", match: (p: string) => p.startsWith("/settings") },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [health, setHealth] = useState<Health | null | "down">(null);

  useEffect(() => {
    api.health().then(setHealth, () => setHealth("down"));
  }, [pathname]);

  let status: React.ReactNode = <span className="status-text">Connecting to backend</span>;
  if (health === "down") status = <span className="status status--failed">Backend offline</span>;
  else if (health) {
    status = health.ai_enabled ? (
      <span className="status-text">
        AI on, <span className="mono">{health.model}</span>
      </span>
    ) : (
      <Link href="/settings" className="status-text">
        AI off, set it up in Settings
      </Link>
    );
  }

  const inProject = pathname.startsWith("/p/");

  return (
    <>
      <header className="topbar">
        <div className="container" style={inProject ? { maxWidth: "none" } : undefined}>
          <Link href="/" className="wordmark" aria-label="TestPilot, all projects">
            <Wordmark />
          </Link>
          <nav className="nav" aria-label="Main">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} aria-current={l.match(pathname) ? "page" : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="topbar-status">
            <span role="status">{status}</span>
            <ThemeSwitch />
          </div>
        </div>
      </header>
      {inProject ? children : <main className="container page">{children}</main>}
    </>
  );
}
