import type { Metadata } from "next";
import { Suspense } from "react";
import { NewPlanFlow } from "./NewPlanFlow";

export const metadata: Metadata = { title: "New test plan, TestPilot" };

export default function NewPlanPage() {
  return (
    <Suspense>
      <NewPlanFlow />
    </Suspense>
  );
}
