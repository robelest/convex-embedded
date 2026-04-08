import { api } from "$convex/_generated/api";
import { useQuery } from "convex/react";
import React from "react";
import {
  SectionList,
  View,
  Text,
  Pressable,
  Alert,
  StyleSheet,
  ActivityIndicator,
} from "react-native";

import { IssueRow } from "@/src/components/IssueRow";
import { SectionHeader } from "@/src/components/SectionHeader";
import { client } from "@/src/convex-client";
import { colors } from "@/src/theme";

const STATUS_ORDER = [
  "in_progress",
  "todo",
  "backlog",
  "done",
  "cancelled",
] as const;
const STATUS_LABELS: Record<string, string> = {
  in_progress: "In Progress",
  todo: "Todo",
  backlog: "Backlog",
  done: "Done",
  cancelled: "Cancelled",
};

export default function IssuesScreen() {
  const dashboard = useQuery(api.dashboard.get, {});
  const projectId = dashboard?.selectedWorkspace?.projects?.[0]?._id;
  const issuesData = useQuery(
    api.issues.forProject,
    projectId ? { projectId } : "skip",
  );

  if (!dashboard || !issuesData) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent[500]} />
      </View>
    );
  }

  const issues = issuesData.issues;
  type IssueItem = (typeof issues)[number];
  const sections = STATUS_ORDER.map((status) => ({
    title: STATUS_LABELS[status],
    data: issues.filter((i: IssueItem) => i.status === status),
  })).filter((s) => s.data.length > 0);

  const handleCreate = () => {
    if (!projectId) return;
    Alert.prompt("New Issue", "Enter a title", (title) => {
      if (title?.trim()) {
        void client.mutation(api.issues.create, {
          projectId,
          title: title.trim(),
        });
      }
    });
  };

  return (
    <View style={styles.root}>
      <SectionList
        style={styles.container}
        sections={sections}
        keyExtractor={(item) => item._id}
        renderItem={({ item }) => <IssueRow issue={item} />}
        renderSectionHeader={({ section }) => (
          <SectionHeader title={section.title} count={section.data.length} />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        SectionSeparatorComponent={() => <View style={styles.sectionGap} />}
        stickySectionHeadersEnabled
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 100 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No issues yet</Text>
          </View>
        }
      />
      <Pressable
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        onPress={handleCreate}
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.warm[50] },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.warm[50],
  },
  separator: { height: 1, backgroundColor: colors.warm[200], marginLeft: 16 },
  sectionGap: { height: 8 },
  empty: { paddingTop: 100, alignItems: "center" },
  emptyText: { color: colors.warm[500], fontSize: 15 },
  fab: {
    position: "absolute",
    bottom: 32,
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accent[500],
    alignItems: "center",
    justifyContent: "center",
    borderCurve: "continuous",
    boxShadow: "0 4px 16px rgba(194, 93, 58, 0.35)",
  },
  fabPressed: { backgroundColor: colors.accent[600] },
  fabIcon: {
    fontSize: 28,
    color: colors.white,
    fontWeight: "300",
    marginTop: -1,
  },
});
