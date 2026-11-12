"use client";

import { Suspense, use } from "react";
import { EditorSkeleton, RequestEditor } from "./RequestEditor";

export default function RequestPage({ params }: { params: Promise<{ projectId: string; itemId: string }> }) {
  const { projectId, itemId } = use(params);
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <RequestEditor projectId={projectId} itemId={itemId} />
    </Suspense>
  );
}
