import { api } from "$convex/_generated/api";
import { useQuery } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";

import { AssigneePicker } from "@/src/components/AssigneePicker";
import { PriorityPicker } from "@/src/components/PriorityPicker";
import RichTextEditor from "@/src/components/RichTextEditor";
import { StatusPicker } from "@/src/components/StatusPicker";
import { client } from "@/src/convex-client";
import { colors } from "@/src/theme";

const EMPTY_DESCRIPTION = {
  type: "doc",
  content: [{ type: "paragraph" }],
} as const;

type RichTextContent = Record<string, unknown>;

function normalizeRichTextContent(content?: RichTextContent): RichTextContent {
  if (!content || Array.isArray(content)) {
    return EMPTY_DESCRIPTION;
  }

  return content;
}

export default function IssueDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState<RichTextContent | null>(null);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dashboard = useQuery(api.dashboard.get, {});
  const projectId = dashboard?.selectedWorkspace?.projects?.[0]?.projectId;
  const members = dashboard?.selectedWorkspace?.members ?? [];
  const issuesData = useQuery(
    api.issues.forProject,
    projectId ? { projectId } : "skip",
  );
  type IssueItem = NonNullable<typeof issuesData>["issues"][number];
  const issue = issuesData?.issues.find((i: IssueItem) => i.issueId === id);

  const commentsData = useQuery(
    api.comments.forIssue,
    issue ? { issueId: issue.issueId as any } : "skip",
  );
  const issueDescription = normalizeRichTextContent(
    issue?.description as RichTextContent | undefined,
  );
  const serializedIssueDescription = useMemo(
    () => JSON.stringify(issueDescription),
    [issueDescription],
  );
  const lastSubmittedDescription = useRef<string | null>(null);
  const previousIssueDescription = useRef(serializedIssueDescription);

  useEffect(() => {
    const previousSerialized = previousIssueDescription.current;
    previousIssueDescription.current = serializedIssueDescription;

    setDescDraft((current) => {
      if (current === null) {
        return issueDescription;
      }

      return JSON.stringify(current) === previousSerialized
        ? issueDescription
        : current;
    });
  }, [issueDescription, serializedIssueDescription]);

  if (!issue) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent[500]} />
      </View>
    );
  }

  type CommentItem = NonNullable<typeof commentsData>[number];
  const comments = commentsData ?? [];

  const updateIssue = useCallback(
    (fields: Record<string, unknown>) => {
      void client.mutation(api.issues.update, {
        issueId: issue.issueId as any,
        ...fields,
      });
    },
    [issue.issueId],
  );

  const handleTitleSubmit = () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft.trim() !== issue.title) {
      updateIssue({ title: titleDraft.trim() });
    }
  };

  const handlePostComment = async () => {
    if (!commentText.trim()) return;
    setPosting(true);
    try {
      await client.mutation(api.comments.create, {
        issueId: issue.issueId as any,
        body: commentText.trim(),
      });
      setCommentText("");
    } finally {
      setPosting(false);
    }
  };

  const handleDeleteComment = (commentId: string) => {
    Alert.alert("Delete comment?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          client.mutation(api.comments.remove, { commentId: commentId as any }),
      },
    ]);
  };

  const handleDeleteIssue = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await client.mutation(api.issues.remove, { issueId: issue.issueId as any });
    router.back();
  };

  const editingDescription = descDraft ?? issueDescription;
  const serializedEditingDescription = useMemo(
    () => JSON.stringify(editingDescription),
    [editingDescription],
  );
  const isDescriptionDirty =
    serializedEditingDescription !== serializedIssueDescription;

  useEffect(() => {
    if (lastSubmittedDescription.current === serializedIssueDescription) {
      lastSubmittedDescription.current = null;
    }
  }, [serializedIssueDescription]);

  useEffect(() => {
    if (!isDescriptionDirty) {
      return;
    }

    if (lastSubmittedDescription.current === serializedEditingDescription) {
      return;
    }

    const timeout = setTimeout(() => {
      lastSubmittedDescription.current = serializedEditingDescription;
      updateIssue({ description: editingDescription });
    }, 500);

    return () => {
      clearTimeout(timeout);
    };
  }, [
    editingDescription,
    isDescriptionDirty,
    serializedEditingDescription,
    updateIssue,
  ]);

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
          onSelect={(status) => updateIssue({ status })}
        />
      </View>

      {/* Priority picker */}
      <View style={styles.pickerSection}>
        <Text style={styles.sectionLabel}>Priority</Text>
        <PriorityPicker
          value={issue.priority}
          onSelect={(priority) => updateIssue({ priority })}
        />
      </View>

      {/* Labels */}
      {issue.labels.length > 0 && (
        <View style={styles.labelsRow}>
          {issue.labels.map((label: string) => (
            <View key={label} style={styles.labelChip}>
              <Text style={styles.labelText}>{label}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Description */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Description</Text>
        <View style={styles.editorWrap}>
          <RichTextEditor
            content={editingDescription}
            onChange={async (content) => {
              setDescDraft(content);
            }}
            style={{ height: 176 }}
          />
        </View>
      </View>

      {/* Assignee */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Assignee</Text>
        <AssigneePicker
          value={issue.assigneeUserId}
          assigneeName={issue.assigneeName}
          members={members.map((m) => ({ userId: m.userId, name: m.name }))}
          onSelect={(userId) => updateIssue({ assigneeUserId: userId })}
        />
      </View>

      {/* Comments */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Comments{comments.length > 0 ? ` (${comments.length})` : ""}
        </Text>

        {comments.map((comment: CommentItem, idx: number) => (
          <Pressable
            key={comment.commentId}
            onLongPress={() => handleDeleteComment(comment.commentId)}
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
  description: { fontSize: 15, color: colors.warm[700], lineHeight: 24 },
  editorWrap: {
    minHeight: 176,
  },
  descPlaceholder: { color: colors.warm[400], fontStyle: "italic" },
  descInput: {
    fontSize: 15,
    color: colors.warm[700],
    lineHeight: 24,
    minHeight: 80,
    borderWidth: 1,
    borderColor: colors.warm[300],
    borderRadius: 8,
    padding: 12,
    backgroundColor: colors.warm[50],
    textAlignVertical: "top",
    borderCurve: "continuous",
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
