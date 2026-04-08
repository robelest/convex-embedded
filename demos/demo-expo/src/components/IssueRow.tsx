import { useRouter } from "expo-router";
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

import { colors } from "@/src/theme";

import { PriorityChip } from "./PriorityChip";
import { StatusDot } from "./StatusDot";

interface IssueItem {
  _id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeName: string | null;
}

export function IssueRow({ issue }: { issue: IssueItem }) {
  const router = useRouter();

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={() => router.push(`/issue/${issue._id}`)}
    >
      <StatusDot status={issue.status as any} />
      <Text style={styles.identifier}>{issue.identifier}</Text>
      <View style={styles.titleWrap}>
        <Text style={styles.title} numberOfLines={1}>
          {issue.title}
        </Text>
      </View>
      <View style={styles.trailing}>
        <PriorityChip priority={issue.priority as any} />
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.white,
  },
  pressed: { backgroundColor: colors.warm[100] },
  identifier: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.warm[500],
    marginLeft: 12,
    width: 56,
  },
  titleWrap: { flex: 1, marginLeft: 8 },
  title: { fontSize: 15, color: colors.warm[900] },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: 8,
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent[500],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 10, fontWeight: "700", color: colors.white },
});
