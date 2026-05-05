import { api } from "$convex/_generated/api";
import { useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  InteractionManager,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { IssueRow } from "@/src/components/IssueRow";
import { useEmbeddedClient } from "@/src/convex-client";
import { useOverlayGuard } from "@/src/overlay-guard";
import { useProjectSelection } from "@/src/project-selection";
import { colors } from "@/src/theme";
import { markUiClick } from "@/src/ui-timing";
import {
  type WorkspaceProject,
  useWorkspaceData,
} from "@/src/use-workspace-data";

const Separator = () => <View style={styles.separator} />;

export default function IssuesScreen() {
  const client = useEmbeddedClient();
  const { workspace, projects } = useWorkspaceData();
  const { selectedProjectId, setSelectedProjectId } = useProjectSelection();
  const { requestOverlay } = useOverlayGuard();
  const [readyForSync, setReadyForSync] = React.useState(false);

  React.useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setReadyForSync(true);
    });
    return () => task.cancel();
  }, []);

  React.useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0]!._id);
    }
  }, [projects, selectedProjectId, setSelectedProjectId]);

  const selectedProject = React.useMemo<WorkspaceProject | null>(
    () =>
      projects.find(
        (project: WorkspaceProject) => project._id === selectedProjectId,
      ) ??
      projects[0] ??
      null,
    [projects, selectedProjectId],
  );

  const issues = useQuery(
    api.issues.forProjectAll,
    readyForSync && selectedProject
      ? { projectId: selectedProject._id }
      : "skip",
  );

  type IssueItem = NonNullable<typeof issues>[number];

  const handleRowPress = React.useCallback(
    (id: string) => {
      markUiClick("issue.open", { id });
      requestOverlay(`issue:${id}`, () => {
        router.push(`/issue/${id}`);
      });
    },
    [requestOverlay],
  );

  const renderItem = React.useCallback(
    ({ item }: { item: IssueItem }) => (
      <IssueRow issue={item} onPress={handleRowPress} />
    ),
    [handleRowPress],
  );

  const keyExtractor = React.useCallback((item: IssueItem) => item._id, []);

  const handleOpenProjects = React.useCallback(() => {
    if (!selectedProject) return;
    markUiClick("projects.open");
    requestOverlay("project-picker", () => {
      router.push({
        pathname: "/project-picker",
        params: { project: selectedProject._id },
      });
    });
  }, [requestOverlay, selectedProject]);

  const handleCreateIssue = React.useCallback(() => {
    if (!selectedProject) return;
    Alert.prompt("New Issue", "Enter a title", (title) => {
      if (!title?.trim()) {
        return;
      }
      void (async () => {
        void Haptics.selectionAsync();
        const issueId = await client.mutation(api.issues.create, {
          projectId: selectedProject._id,
          title: title.trim(),
        });
        requestOverlay(`issue:${issueId}`, () => {
          router.push(`/issue/${issueId}`);
        });
      })();
    });
  }, [requestOverlay, selectedProject]);

  if (
    !workspace ||
    !selectedProject ||
    !readyForSync ||
    issues === undefined
  ) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent[500]} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <FlatList
        data={issues}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        windowSize={5}
        initialNumToRender={20}
        maxToRenderPerBatch={10}
        ListHeaderComponent={
          <View style={styles.headerStack}>
            <View style={styles.workspaceRow}>
              <View style={styles.headerRow}>
                <View style={styles.workspaceCopy}>
                  <Text selectable style={styles.headerTitle}>
                    {selectedProject.identifier}
                  </Text>
                </View>

                <View style={styles.workspaceActions}>
                  <Pressable
                    onPress={handleOpenProjects}
                    style={styles.secondaryButton}
                  >
                    <Text selectable style={styles.secondaryButtonLabel}>
                      Projects
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Text selectable style={styles.emptyText}>
              No issues yet
            </Text>
          </View>
        }
      />

      <Pressable
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        onPress={handleCreateIssue}
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.warm[50] },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.warm[50],
  },
  content: {
    paddingHorizontal: 12,
    paddingBottom: 112,
    gap: 8,
  },
  headerStack: {
    gap: 6,
    paddingBottom: 8,
  },
  workspaceRow: {
    paddingTop: 4,
    paddingBottom: 4,
  },
  workspaceRowPressed: {
    opacity: 0.82,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  workspaceCopy: {
    gap: 1,
    flex: 1,
  },
  headerTitle: {
    fontSize: 21,
    lineHeight: 24,
    color: colors.warm[900],
    fontWeight: "500",
  },
  workspaceActions: {
    alignItems: "flex-end",
  },
  secondaryButton: {
    borderRadius: 10,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.warm[300],
    backgroundColor: colors.white,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  secondaryButtonLabel: {
    fontSize: 10,
    color: colors.warm[700],
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  separator: {
    height: 1,
    backgroundColor: colors.warm[200],
    marginLeft: 14,
  },
  emptyCard: {
    borderRadius: 18,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.warm[300],
    backgroundColor: colors.white,
    paddingHorizontal: 14,
    paddingVertical: 20,
    alignItems: "center",
    gap: 6,
  },
  emptyText: { color: colors.warm[500], fontSize: 14 },
  fab: {
    position: "absolute",
    bottom: 32,
    right: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.accent[500],
    alignItems: "center",
    justifyContent: "center",
    borderCurve: "continuous",
    boxShadow: "0 8px 24px rgba(194, 93, 58, 0.28)",
  },
  fabPressed: { backgroundColor: colors.accent[600] },
  fabIcon: {
    fontSize: 28,
    color: colors.white,
    fontWeight: "300",
    marginTop: -1,
  },
});
