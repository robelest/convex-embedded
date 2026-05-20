import type { Id } from "$convex/_generated/dataModel";
import { useLocalSearchParams, useRouter } from "expo-router";
import React from "react";

import { IssueDetail } from "@/src/components/IssueDetail";

export default function IssueDetailRoute() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const handleDismiss = React.useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);

  if (typeof id !== "string") return null;
  return (
    <IssueDetail issueId={id as Id<"issues">} onDismiss={handleDismiss} />
  );
}
