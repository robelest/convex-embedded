import React from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";

import { colors, statusColors } from "@/src/theme";

const STATUSES = [
  "in_progress",
  "todo",
  "backlog",
  "done",
  "cancelled",
] as const;
const LABELS: Record<string, string> = {
  in_progress: "In Progress",
  todo: "Todo",
  backlog: "Backlog",
  done: "Done",
  cancelled: "Cancelled",
};

export function StatusPicker({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (status: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {STATUSES.map((status) => {
        const active = value === status;
        const dotColor = statusColors[status];
        return (
          <Pressable
            key={status}
            onPress={() => onSelect(status)}
            style={[
              styles.pill,
              active && {
                backgroundColor: dotColor + "18",
                borderColor: dotColor + "40",
              },
            ]}
          >
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
            <Text
              style={[
                styles.label,
                active && { color: colors.warm[900], fontWeight: "600" },
              ]}
            >
              {LABELS[status]}
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
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.warm[300],
    backgroundColor: colors.white,
    borderCurve: "continuous",
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 13, color: colors.warm[600] },
});
