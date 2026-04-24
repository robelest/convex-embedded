import React from "react";
import { View, Text, StyleSheet } from "react-native";

import { priorityColors } from "@/src/theme";

type IssuePriority = "none" | "low" | "medium" | "high" | "urgent";

const PRIORITY_LABELS: Record<IssuePriority, string> = {
  none: "",
  low: "Low",
  medium: "Med",
  high: "High",
  urgent: "Urgent",
};

export function PriorityChip({ priority }: { priority: IssuePriority }) {
  const c = priorityColors[priority];
  if (priority === "none") {
    return null;
  }
  return (
    <View
      style={[styles.chip, { backgroundColor: c.bg, borderColor: c.border }]}
    >
      <Text style={[styles.label, { color: c.text }]}>
        {PRIORITY_LABELS[priority]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  label: {
    fontSize: 10,
    fontWeight: "600",
  },
});
