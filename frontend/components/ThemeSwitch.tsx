"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

type Mode = "light" | "dark";
export const THEME_KEY = "testpilot-theme";

/** Runs before first paint (see layout.tsx) so a stored choice never flashes the other theme. */
export const THEME_BOOT = `try{var m=localStorage.getItem("${THEME_KEY}");if(m==="light"||m==="dark")document.documentElement.dataset.theme=m}catch(e){}`;

function current(): Mode {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Light or dark. Until someone picks, it follows the operating system and shows which one that is. */
export function ThemeSwitch() {
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => setMode(current()), []);

  const pick = (m: Mode) => {
    document.documentElement.dataset.theme = m;
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {}
    setMode(m);
  };

  return (
    <div className="theme-switch" role="group" aria-label="Colour theme">
      <button type="button" aria-pressed={mode === "light"} aria-label="Light theme" title="Light" onClick={() => pick("light")}>
        <Icon name="sun" />
      </button>
      <button type="button" aria-pressed={mode === "dark"} aria-label="Dark theme" title="Dark" onClick={() => pick("dark")}>
        <Icon name="moon" />
      </button>
    </div>
  );
}
