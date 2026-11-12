"use client";

import { Suspense, use } from "react";
import { PlanReview, PlanSkeleton } from "./PlanReview";

export default function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<PlanSkeleton />}>
      <PlanReview id={id} />
    </Suspense>
  );
}
