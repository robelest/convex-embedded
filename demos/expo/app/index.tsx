import { api } from "$convex/_generated/api";
import { usePaginatedQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { IssueRow } from "@/src/components/IssueRow";
import { useEmbeddedClient } from "@/src/convex-client";
import { useOverlayGuard } from "@/src/overlay-guard";
import { useProjectSelection } from "@/src/project-selection";
import { colors } from "@/src/theme";
import { markUiClick } from "@/src/ui-timing";
import { type Project, useProjects } from "@/src/use-projects";

const Separator = () => <View style={styles.separator} />;
const PAGE_SIZE = 100;

export default function IssuesScreen() {
  const client = useEmbeddedClient();
  const projects = useProjects();
  const { selectedProjectId, setSelectedProjectId } = useProjectSelection();
  const { requestOverlay } = useOverlayGuard();
  const [readyForSync, setReadyForSync] = React.useState(false);
  const [createVisible, setCreateVisible] = React.useState(false);
  const [createTitle, setCreateTitle] = React.useState("");

  React.useLayoutEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setReadyForSync(true);
    });
    return () => task.cancel();
  }, []);

  React.useLayoutEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0]!._id);
    }
  }, [projects, selectedProjectId, setSelectedProjectId]);

  const selectedProject = React.useMemo<Project | null>(
    () =>
      projects.find((project: Project) => project._id === selectedProjectId) ??
      projects[0] ??
      null,
    [projects, selectedProjectId],
  );

  const {
    results: issues,
    status: issuesStatus,
    loadMore: loadMoreIssues,
  } = usePaginatedQuery(
    api.issues.forProject,
    readyForSync && selectedProject
      ? { projectId: selectedProject._id }
      : "skip",
    { initialNumItems: PAGE_SIZE },
  );

  type IssueItem = (typeof issues)[number];

  const handleLoadMoreIssues = React.useCallback(() => {
    if (issuesStatus === "CanLoadMore") {
      loadMoreIssues(PAGE_SIZE);
    }
  }, [issuesStatus, loadMoreIssues]);

  const handleRowPress = React.useCallback(
    (id: string) => {
      markUiClick("issue.open", { id });
      void Haptics.selectionAsync();
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
    markUiClick("projects.open");
    void Haptics.selectionAsync();
    requestOverlay("project-picker", () => {
      router.push({
        pathname: "/project-picker",
        params: selectedProjectId ? { project: selectedProjectId } : {},
      });
    });
  }, [requestOverlay, selectedProjectId]);

  const handleSubmitIssue = React.useCallback(() => {
    if (!selectedProject) return;
    const title = createTitle.trim();
    if (!title) return;
    setCreateVisible(false);
    setCreateTitle("");
    void Haptics.selectionAsync();
    client
      .mutation(api.issues.create, {
        projectId: selectedProject._id,
        title,
      })
      .then((issueId) => {
        requestOverlay(`issue:${issueId}`, () => {
          router.push(`/issue/${issueId}`);
        });
      })
      .catch(console.error);
  }, [client, createTitle, requestOverlay, selectedProject]);

  if (!readyForSync) {
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
        ListFooterComponent={
          issuesStatus === "LoadingMore" ? (
            <View style={styles.footerLoading}>
              <ActivityIndicator color={colors.accent[500]} />
            </View>
          ) : null
        }
        maxToRenderPerBatch={10}
        onEndReached={handleLoadMoreIssues}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          selectedProject ? (
            <View style={styles.headerStack}>
              <View style={styles.headerOuter}>
                <View style={styles.headerRow}>
                  <View style={styles.headerCopy}>
                    <Text selectable style={styles.headerTitle}>
                      {selectedProject.identifier}
                    </Text>
                  </View>

                  <View style={styles.headerActions}>
                    <Pressable
                      onPressIn={handleOpenProjects}
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
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Text selectable style={styles.emptyText}>
              {selectedProject ? "No issues yet" : "No projects yet"}
            </Text>
          </View>
        }
      />

      {selectedProject && (
        <Pressable
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          onPress={() => setCreateVisible(true)}
        >
          <Text style={styles.fabIcon}>+</Text>
        </Pressable>
      )}

      <Modal
        animationType="fade"
        onRequestClose={() => setCreateVisible(false)}
        transparent
        visible={createVisible}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New issue</Text>
            <TextInput
              autoFocus
              maxLength={120}
              onChangeText={setCreateTitle}
              onSubmitEditing={handleSubmitIssue}
              placeholder="Issue title"
              returnKeyType="done"
              style={styles.titleInput}
              value={createTitle}
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setCreateVisible(false)}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={createTitle.trim().length === 0}
                onPress={handleSubmitIssue}
                style={({ pressed }) => [
                  styles.createButton,
                  pressed && styles.createButtonPressed,
                  createTitle.trim().length === 0 &&
                    styles.createButtonDisabled,
                ]}
              >
                <Text style={styles.createButtonLabel}>Create</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  headerOuter: {
    paddingTop: 4,
    paddingBottom: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  headerCopy: {
    gap: 1,
    flex: 1,
  },
  headerTitle: {
    fontSize: 21,
    lineHeight: 24,
    color: colors.warm[900],
    fontWeight: "500",
  },
  headerActions: {
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
  footerLoading: {
    alignItems: "center",
    paddingVertical: 16,
  },
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
  modalBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(30, 24, 18, 0.34)",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    gap: 14,
    borderRadius: 18,
    borderCurve: "continuous",
    backgroundColor: colors.white,
    padding: 16,
  },
  modalTitle: {
    color: colors.warm[900],
    fontSize: 18,
    fontWeight: "600",
  },
  titleInput: {
    borderWidth: 1,
    borderColor: colors.warm[300],
    borderRadius: 12,
    color: colors.warm[900],
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  createButton: {
    borderRadius: 10,
    borderCurve: "continuous",
    backgroundColor: colors.accent[500],
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  createButtonPressed: { backgroundColor: colors.accent[600] },
  createButtonDisabled: { opacity: 0.5 },
  createButtonLabel: {
    color: colors.white,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
});
