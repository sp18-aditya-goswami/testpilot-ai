"use client";

import { use } from "react";
import { SuiteScreen } from "./SuiteScreen";

export default function SuitePage({ params }: { params: Promise<{ projectId: string; itemId: string }> }) {
  const { projectId, itemId } = use(params);
  return <SuiteScreen key={itemId} projectId={projectId} itemId={itemId} />;
}
