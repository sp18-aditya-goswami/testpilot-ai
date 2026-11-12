"use client";

import { Suspense, use } from "react";
import { PlanReview, PlanSkeleton } from "@/app/plans/[id]/PlanReview";

export default function ProjectPlanPage({ params }: { params: Promise<{ projectId: string; planId: string }> }) {
  const { planId } = use(params);
  return (
    <Suspense fallback={<PlanSkeleton />}>
      <PlanReview id={planId} />
    </Suspense>
  );
}
