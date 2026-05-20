import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  InteractionManager,
} from "react-native";

import { AssigneePicker } from "@/src/components/AssigneePicker";
import { PriorityPicker } from "@/src/components/PriorityPicker";
import { StatusPicker } from "@/src/components/StatusPicker";
import { useEmbeddedClient } from "@/src/convex-client";
import { useOverlayRegistration } from "@/src/overlay-guard";
import { useProjectSelection } from "@/src/project-selection";
import { colors } from "@/src/theme";
import {
  endUiMark,
  markUiClick,
  useTimeUiUpdate,
} from "@/src/ui-timing";
import { members } from "$convex/access";
import { useProjects } from "@/src/use-projects";

export default function IssueDetail() {
  const client = useEmbeddedClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [readyForComments, setReadyForComments] = useState(false);

  useOverlayRegistration(`issue:${id}`);

  React.useLayoutEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setReadyForComments(true);
    });
    return () => task.cancel();
  }, []);

  const projects = useProjects();
  const { selectedProjectId } = useProjectSelection();
  const issue = useQuery(
    api.issues.detail,
    typeof id === "string" ? { issueId: id as Id<"issues"> } : "skip",
  );
  const selectedProject =
    projects.find((project) => project._id === selectedProjectId) ??
    projects.find((project) => project._id === issue?.projectId) ??
    null;
  React.useLayoutEffect(() => {
    endUiMark("issue.open", "sheet-mounted");
  }, []);
  React.useLayoutEffect(() => {
    if (!issue) return;
    endUiMark("issue.open", "data-ready");
  }, [issue]);
  useTimeUiUpdate("issue.open", issue?._id ?? null);
  useTimeUiUpdate("issue.status", issue?.status ?? null);
  useTimeUiUpdate("issue.priority", issue?.priority ?? null);
  useTimeUiUpdate("issue.title", issue?.title ?? null);
  useTimeUiUpdate("issue.assignee", issue?.assigneeUserId ?? null);

  const commentsData = useQuery(
    api.comments.forIssue,
    readyForComments && issue ? { issueId: issue._id } : "skip",
  );

  type CommentItem = NonNullable<typeof commentsData>[number];
  const comments = commentsData ?? [];
  useTimeUiUpdate("comment.create", comments.length);

  const updateIssue = useCallback(
    (fields: Record<string, unknown>) => {
      if (!issue) {
        return;
      }
      const changed = Object.entries(fields).filter(([key, value]) => {
        const current = (issue as Record<string, unknown>)[key];
        return current !== value;
      });
      if (changed.length === 0) {
        return;
      }
      const patch = Object.fromEntries(changed);
      // The SDK's auto-derive optimistic path runs synchronously inside
      // client.mutation(): it writes to the cache and fires React
      // subscribers from this call stack, so React 18 treats the setState
      // as discrete-event priority. No optimistic-callback boilerplate
      // needed here.
      void client.mutation(api.issues.update, {
        issueId: issue._id,
        ...patch,
      });
    },
    [client, issue],
  );

  const handleTitleSubmit = useCallback(() => {
    setEditingTitle(false);
    if (!issue) {
      return;
    }
    if (titleDraft.trim() && titleDraft.trim() !== issue.title) {
      markUiClick("issue.title");
      updateIssue({ title: titleDraft.trim() });
      endUiMark("issue.title", "mutation-dispatched");
    }
  }, [issue, titleDraft, updateIssue]);

  const handlePostComment = useCallback(async () => {
    if (!issue || !commentText.trim()) return;
    markUiClick("comment.create", { length: commentText.trim().length });
    setPosting(true);
    try {
      const promise = client.mutation(api.comments.create, {
        issueId: issue._id,
        body: commentText.trim(),
      });
      endUiMark("comment.create", "mutation-dispatched");
      await promise;
      endUiMark("comment.create", "mutation-resolved");
      setCommentText("");
    } finally {
      setPosting(false);
    }
  }, [client, commentText, issue]);

  const handleDeleteComment = useCallback(
    (commentId: Id<"comments">) => {
      Alert.alert("Delete comment?", "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => client.mutation(api.comments.remove, { commentId }),
        },
      ]);
    },
    [client],
  );

  const handleDeleteIssue = useCallback(async () => {
    if (!issue) {
      return;
    }
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await client.mutation(api.issues.remove, { issueId: issue._id });
    router.back();
  }, [client, confirmDelete, issue, router]);

  if (!issue) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent[500]} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
    >
      {/* Identifier */}
      <Text style={styles.identifier}>{issue.identifier}</Text>

      {/* Title — tap to edit */}
      {editingTitle ? (
        <TextInput
          style={styles.titleInput}
          value={titleDraft}
          onChangeText={setTitleDraft}
          onBlur={handleTitleSubmit}
          onSubmitEditing={handleTitleSubmit}
          autoFocus
          multiline
          maxLength={120}
        />
      ) : (
        <Pressable
          onPress={() => {
            setTitleDraft(issue.title);
            setEditingTitle(true);
          }}
        >
          <Text selectable style={styles.title}>
            {issue.title}
          </Text>
        </Pressable>
      )}

      {/* Status picker */}
      <View style={styles.pickerSection}>
        <Text style={styles.sectionLabel}>Status</Text>
        <StatusPicker
          value={issue.status}
          onSelect={(status) => {
            markUiClick("issue.status", { from: issue.status, to: status });
            updateIssue({ status });
            endUiMark("issue.status", "mutation-dispatched");
          }}
        />
      </View>

      {/* Priority picker */}
      <View style={styles.pickerSection}>
        <Text style={styles.sectionLabel}>Priority</Text>
        <PriorityPicker
          value={issue.priority}
          onSelect={(priority) => {
            markUiClick("issue.priority", {
              from: issue.priority,
              to: priority,
            });
            updateIssue({ priority });
            endUiMark("issue.priority", "mutation-dispatched");
          }}
        />
      </View>

      {/* Labels */}
      {(issue.labels?.length ?? 0) > 0 && (
        <View style={styles.labelsRow}>
          {issue.labels?.map((label: string) => (
            <View key={label} style={styles.labelChip}>
              <Text style={styles.labelText}>{label}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Assignee */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Assignee</Text>
        <AssigneePicker
          value={issue.assigneeUserId}
          assigneeName={issue.assigneeName}
          members={members.map((m) => ({ userId: m.userId, name: m.name }))}
          onSelect={(userId) => {
            markUiClick("issue.assignee", {
              from: issue.assigneeUserId ?? null,
              to: userId,
            });
            updateIssue({ assigneeUserId: userId });
            endUiMark("issue.assignee", "mutation-dispatched");
          }}
        />
      </View>

      {/* Comments */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Comments{comments.length > 0 ? ` (${comments.length})` : ""}
        </Text>

        {comments.map((comment: CommentItem, idx: number) => (
          <Pressable
            key={comment._id}
            onLongPress={() => handleDeleteComment(comment._id)}
            style={[styles.comment, idx > 0 && styles.commentBorder]}
          >
            <View style={styles.commentHeader}>
              <View style={styles.commentAvatar}>
                <Text style={styles.commentAvatarText}>
                  {comment.authorName.charAt(0)}
                </Text>
              </View>
              <Text style={styles.commentAuthor}>{comment.authorName}</Text>
              <Text style={styles.commentDate}>
                {new Date(comment.createdAt).toLocaleDateString()}
              </Text>
            </View>
            <Text selectable style={styles.commentBody}>
              {comment.body}
            </Text>
          </Pressable>
        ))}

        {/* Comment input */}
        <View
          style={[
            styles.commentInput,
            comments.length > 0 && styles.commentBorder,
          ]}
        >
          <TextInput
            style={styles.commentTextInput}
            value={commentText}
            onChangeText={setCommentText}
            placeholder="Add a comment…"
            placeholderTextColor={colors.warm[400]}
            multiline
            maxLength={500}
          />
          <Pressable
            onPress={handlePostComment}
            disabled={!commentText.trim() || posting}
            style={[
              styles.postBtn,
              (!commentText.trim() || posting) && styles.postBtnDisabled,
            ]}
          >
            <Text style={styles.postBtnText}>{posting ? "…" : "Post"}</Text>
          </Pressable>
        </View>
      </View>

      {/* Delete issue */}
      <View style={styles.dangerZone}>
        <Pressable
          onPress={handleDeleteIssue}
          style={[styles.deleteBtn, confirmDelete && styles.deleteBtnConfirm]}
        >
          <Text
            style={[
              styles.deleteBtnText,
              confirmDelete && styles.deleteBtnTextConfirm,
            ]}
          >
            {confirmDelete ? "Confirm Delete" : "Delete Issue"}
          </Text>
        </Pressable>
        {confirmDelete && (
          <Pressable onPress={() => setConfirmDelete(false)}>
            <Text style={styles.cancelDelete}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.warm[50] },
  content: { paddingBottom: 120 },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.warm[50],
  },

  identifier: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.warm[400],
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.warm[900],
    lineHeight: 28,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  titleInput: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.warm[900],
    lineHeight: 28,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: colors.accent[500],
  },

  pickerSection: {
    borderTopWidth: 1,
    borderTopColor: colors.warm[200],
    paddingTop: 8,
    paddingBottom: 4,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1.6,
    color: colors.warm[500],
    paddingHorizontal: 16,
    marginBottom: 2,
  },

  labelsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.warm[200],
  },
  labelChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.warm[100],
    borderWidth: 1,
    borderColor: colors.warm[300],
    borderCurve: "continuous",
  },
  labelText: { fontSize: 12, fontWeight: "500", color: colors.warm[600] },

  section: {
    marginTop: 12,
    backgroundColor: colors.white,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.warm[200],
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1.6,
    color: colors.warm[500],
    marginBottom: 10,
  },
  comment: { paddingVertical: 12 },
  commentBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.warm[200],
    marginTop: 4,
    paddingTop: 12,
  },
  commentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  commentAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.warm[500],
    alignItems: "center",
    justifyContent: "center",
  },
  commentAvatarText: { fontSize: 9, fontWeight: "700", color: colors.white },
  commentAuthor: { fontSize: 13, fontWeight: "600", color: colors.warm[800] },
  commentDate: { fontSize: 11, color: colors.warm[400] },
  commentBody: {
    fontSize: 14,
    color: colors.warm[700],
    lineHeight: 20,
    marginLeft: 30,
  },

  commentInput: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingTop: 12,
  },
  commentTextInput: {
    flex: 1,
    fontSize: 14,
    color: colors.warm[700],
    borderWidth: 1,
    borderColor: colors.warm[300],
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 38,
    maxHeight: 100,
    backgroundColor: colors.warm[50],
    borderCurve: "continuous",
  },
  postBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: colors.accent[500],
    borderRadius: 10,
    borderCurve: "continuous",
  },
  postBtnDisabled: { opacity: 0.4 },
  postBtnText: { fontSize: 14, fontWeight: "600", color: colors.white },

  dangerZone: {
    marginTop: 24,
    paddingHorizontal: 16,
    alignItems: "center",
    gap: 8,
  },
  deleteBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.warm[300],
    borderCurve: "continuous",
  },
  deleteBtnConfirm: {
    borderColor: "#dc2626",
    backgroundColor: "#dc262610",
  },
  deleteBtnText: { fontSize: 14, fontWeight: "500", color: colors.warm[500] },
  deleteBtnTextConfirm: { color: "#dc2626", fontWeight: "600" },
  cancelDelete: { fontSize: 13, color: colors.warm[500] },
});
