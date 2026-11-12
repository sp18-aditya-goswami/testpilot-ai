"use client";

import { useId, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import styles from "./menu.module.css";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown under a disabled item to say why. */
  reason?: string;
  danger?: boolean;
}

/** A row action menu on the Popover API: light dismiss and Escape come from the browser; focus returns to the trigger. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const place = () => {
    const t = trigger.current?.getBoundingClientRect();
    const p = pop.current;
    if (!t || !p) return;
    const width = p.offsetWidth || 220;
    const left = Math.min(Math.max(8, t.right - width), window.innerWidth - width - 8);
    const below = t.bottom + 4;
    const top = below + p.offsetHeight > window.innerHeight - 8 ? Math.max(8, t.top - p.offsetHeight - 4) : below;
    p.style.left = `${left}px`;
    p.style.top = `${top}px`;
  };

  const close = () => {
    pop.current?.hidePopover();
    trigger.current?.focus();
  };

  const focusItem = (dir: 1 | -1) => {
    const buttons = Array.from(pop.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + dir + buttons.length) % buttons.length].focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation();
          const p = pop.current;
          if (!p) return;
          if (open) p.hidePopover();
          else {
            p.showPopover();
            place();
            p.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
          }
        }}
      >
        <Icon name="more" />
      </button>
      <div
        ref={pop}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className={styles.menu}
        onToggle={(e) => setOpen((e as unknown as ToggleEvent).newState === "open")}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            focusItem(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            focusItem(-1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        {items.map((item) => (
          <div key={item.label} className={styles.entry}>
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${item.danger ? styles.danger : ""}`}
              disabled={item.disabled}
              onClick={(e) => {
                e.stopPropagation();
                pop.current?.hidePopover();
                item.onSelect();
              }}
            >
              {item.icon && <Icon name={item.icon} />}
              {item.label}
            </button>
            {item.disabled && item.reason && <span className={styles.reason}>{item.reason}</span>}
          </div>
        ))}
      </div>
    </>
  );
}
