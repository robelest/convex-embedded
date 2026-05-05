import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useOverlayRegistration } from "@/src/overlay-guard";
import { useProjectSelection } from "@/src/project-selection";
import { colors } from "@/src/theme";
import { clearUiMark, endUiMark } from "@/src/ui-timing";
import {
  type WorkspaceProject,
  useWorkspaceData,
} from "@/src/use-workspace-data";

export default function ProjectPickerScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const { projects } = useWorkspaceData();
  const { setSelectedProjectId } = useProjectSelection();

  useOverlayRegistration("project-picker");

  React.useEffect(() => {
    if (projects.length === 0) return;
    endUiMark("projects.open", "ready");
    clearUiMark("projects.open");
  }, [projects.length]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      style={styles.scroll}
    >
      <Stack.Screen options={{ title: "Projects" }} />

      <View style={styles.listCard}>
        {projects.map((project: WorkspaceProject) => {
          const active = project._id === params.project;
          return (
            <Pressable
              key={project._id}
              onPress={() => {
                void Haptics.selectionAsync();
                setSelectedProjectId(project._id);
                router.dismiss();
              }}
              style={[styles.row, active && styles.rowActive]}
            >
              <View style={styles.rowMeta}>
                <Text selectable style={styles.identifier}>
                  {project.identifier}
                </Text>
                <Text selectable numberOfLines={1} style={styles.name}>
                  {project.name}
                </Text>
              </View>
              <Text selectable style={styles.count}>
                {project.openIssueCount}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.warm[50] },
  content: { padding: 16, paddingBottom: 28 },
  listCard: {
    backgroundColor: colors.white,
    borderRadius: 26,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.warm[300],
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.warm[200],
    backgroundColor: colors.white,
  },
  rowActive: {
    backgroundColor: "#fbf1eb",
  },
  rowMeta: { flex: 1, gap: 4, paddingRight: 12 },
  identifier: {
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: colors.warm[400],
    fontWeight: "700",
  },
  name: { fontSize: 16, color: colors.warm[900], fontWeight: "500" },
  count: {
    minWidth: 28,
    textAlign: "right",
    fontSize: 12,
    color: colors.accent[500],
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
  },
});
