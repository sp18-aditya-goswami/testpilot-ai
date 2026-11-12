"use client";

import { use } from "react";
import { SpecView } from "./SpecView";

export default function SpecPage({ params }: { params: Promise<{ projectId: string; specId: string }> }) {
  const { projectId, specId } = use(params);
  return <SpecView projectId={projectId} specId={specId} />;
}
