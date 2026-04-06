import React from "react";
import { Text, Pressable, ScrollView, StyleSheet } from "react-native";

import { colors, priorityColors } from "@/src/theme";

const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
const LABELS: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function PriorityPicker({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (priority: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {PRIORITIES.map((priority) => {
        const active = value === priority;
        const c = priorityColors[priority];
        return (
          <Pressable
            key={priority}
            onPress={() => onSelect(priority)}
            style={[
              styles.pill,
              active
                ? { backgroundColor: c.bg, borderColor: c.border }
                : {
                    backgroundColor: colors.white,
                    borderColor: colors.warm[300],
                  },
            ]}
          >
            <Text
              style={[
                styles.label,
                active
                  ? { color: c.text, fontWeight: "600" }
                  : { color: colors.warm[600] },
              ]}
            >
              {LABELS[priority]}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderCurve: "continuous",
  },
  label: { fontSize: 13 },
});
