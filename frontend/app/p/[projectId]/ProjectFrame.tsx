"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Sidebar } from "@/components/Sidebar";
import styles from "./project.module.css";

/** Two panes: the project sidebar and the working area. Under 60rem the sidebar sits behind a disclosure. */
export function ProjectFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className={styles.frame}>
      <div className={`${styles.side} ${open ? styles.sideOpen : ""}`} id="project-sidebar">
        <Sidebar />
      </div>
      <main className={styles.main}>
        <button
          type="button"
          className={`key ${styles.disclosure}`}
          aria-expanded={open}
          aria-controls="project-sidebar"
          onClick={() => setOpen(!open)}
        >
          <Icon name="layers" />
          {open ? "Hide collections" : "Collections"}
        </button>
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}
