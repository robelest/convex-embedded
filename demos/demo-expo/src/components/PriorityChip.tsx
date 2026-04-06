import React from "react";
import { View, Text, StyleSheet } from "react-native";

import type { Priority } from "@/src/data/mock";
import { PRIORITY_LABELS } from "@/src/data/mock";
import { priorityColors } from "@/src/theme";

export function PriorityChip({ priority }: { priority: Priority }) {
  const c = priorityColors[priority];
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
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
  },
});
