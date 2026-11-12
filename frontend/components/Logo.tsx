/** The TestPilot mark: a measuring frame drawn only at its corners, a probe path inside it, and one lime point where it finds something. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path className="logo-frame" d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" strokeWidth="1.8" strokeLinecap="square" />
      <path className="logo-path" d="M6.5 16.5 10 12l3 2.5 3.2-4.2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="logo-point" cx="17.4" cy="8.6" r="2.3" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <>
      <LogoMark />
      <span className="logo-word">TestPilot</span>
    </>
  );
}
