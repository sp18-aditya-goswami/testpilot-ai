import type { Metadata, Viewport } from "next";
import { Geologica, JetBrains_Mono } from "next/font/google";
import { Shell } from "@/components/Shell";
import { THEME_BOOT } from "@/components/ThemeSwitch";
import "./globals.css";

const geologica = Geologica({ subsets: ["latin"], weight: "variable", axes: ["SHRP"], variable: "--ff-geologica", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400"], variable: "--ff-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "TestPilot",
  description: "Reads an OpenAPI spec, plans contract, AI and fuzz tests, runs them and explains every failure.",
};

export const viewport: Viewport = { colorScheme: "dark light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geologica.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
