import type { Metadata } from "next";
import { Suspense } from "react";
import { RunView } from "@/app/runs/[id]/RunView";

export const metadata: Metadata = { title: "Run results, TestPilot" };

export default async function ProjectRunPage({ params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense>
      <RunView id={runId} />
    </Suspense>
  );
}
