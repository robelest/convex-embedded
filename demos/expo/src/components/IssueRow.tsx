import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

import { colors } from "@/src/theme";

import { PriorityChip } from "./PriorityChip";
import { StatusDot } from "./StatusDot";

interface IssueItem {
  _id: string;
  identifier: string;
  title: string;
  status: "backlog" | "todo" | "in_progress" | "done" | "cancelled";
  priority: "none" | "low" | "medium" | "high" | "urgent";
  assigneeName: string | null;
}

export function IssueRow({
  issue,
  onPress,
}: {
  issue: IssueItem;
  onPress?: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
    >
      <StatusDot status={issue.status} />
      <Text style={styles.identifier}>{issue.identifier}</Text>
      <View style={styles.titleWrap}>
        <Text style={styles.title} numberOfLines={1}>
          {issue.title}
        </Text>
      </View>
      <View style={styles.trailing}>
        <PriorityChip priority={issue.priority} />
        {issue.assigneeName && (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {issue.assigneeName.charAt(0)}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: colors.white,
  },
  pressed: { backgroundColor: colors.warm[100] },
  identifier: {
    fontSize: 10,
    fontWeight: "600",
    color: colors.warm[500],
    marginLeft: 10,
    width: 52,
  },
  titleWrap: { flex: 1, marginLeft: 6 },
  title: { fontSize: 14, color: colors.warm[900] },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginLeft: 6,
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent[500],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 9, fontWeight: "700", color: colors.white },
});
