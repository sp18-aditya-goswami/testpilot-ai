import type { Metadata } from "next";
import { Suspense } from "react";
import { RunView } from "./RunView";

export const metadata: Metadata = { title: "Run results, TestPilot" };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <RunView id={id} />
    </Suspense>
  );
}
