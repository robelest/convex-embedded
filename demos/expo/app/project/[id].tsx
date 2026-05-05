import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useEmbeddedClient } from "@/src/convex-client";
import { useOverlayRegistration } from "@/src/overlay-guard";
import { colors } from "@/src/theme";
import { useWorkspaceData } from "@/src/use-workspace-data";

export default function ProjectWorkbenchScreen() {
  const client = useEmbeddedClient();
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const { projects } = useWorkspaceData();
  const project = projects.find((item) => item._id === id) ?? null;
  const [activeTab, setActiveTab] = React.useState<
    "overview" | "notes" | "assistant"
  >(tab === "notes" || tab === "assistant" ? tab : "overview");
  const [notes, setNotes] = React.useState("");
  const [assistantDraft, setAssistantDraft] = React.useState("");
  const [assistantMessages, setAssistantMessages] = React.useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [isAskingAssistant, setIsAskingAssistant] = React.useState(false);

  useOverlayRegistration(`project:${id}`);

  const handleAskAssistant = React.useCallback(async () => {
    const message = assistantDraft.trim();
    if (!project || message.length === 0) return;
    setIsAskingAssistant(true);
    setAssistantDraft("");
    let historySnapshot: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];
    setAssistantMessages((prev) => {
      historySnapshot = prev;
      return [...prev, { role: "user", content: message }];
    });
    try {
      const result = await client.action(api.agent.chatProject, {
        projectId: project._id as Id<"projects">,
        history: historySnapshot,
        message,
      });
      setAssistantMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.reply },
      ]);
    } finally {
      setIsAskingAssistant(false);
    }
  }, [assistantDraft, project, client]);

  if (!project) {
    return <View style={styles.loading} />;
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: project.identifier }} />
      <View style={styles.headerCard}>
        <Text selectable style={styles.identifier}>
          {project.identifier}
        </Text>
        <Text selectable style={styles.title}>
          {project.name}
        </Text>
        <Text selectable style={styles.meta}>
          {project.openIssueCount} open · {project.issueCounter} total
        </Text>
      </View>

      <View style={styles.segmentedWrap}>
        {(["overview", "notes", "assistant"] as const).map((panel) => {
          const active = panel === activeTab;
          return (
            <Pressable
              key={panel}
              onPress={() => setActiveTab(panel)}
              style={[
                styles.segmentedButton,
                active && styles.segmentedButtonActive,
              ]}
            >
              <Text selectable style={styles.segmentedLabel}>
                {panel === "overview"
                  ? "Overview"
                  : panel === "notes"
                    ? "Notes"
                    : "Assistant"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {activeTab === "overview" ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text selectable style={styles.cardEyebrow}>
              Project workbench
            </Text>
            <Text selectable style={styles.cardMeta}>
              Summary
            </Text>
          </View>
          <View style={styles.summaryGrid}>
            <View style={styles.summaryItem}>
              <Text selectable style={styles.summaryLabel}>
                Open
              </Text>
              <Text selectable style={styles.summaryValue}>
                {project.openIssueCount}
              </Text>
            </View>
            <View style={styles.summaryItem}>
              <Text selectable style={styles.summaryLabel}>
                Total
              </Text>
              <Text selectable style={styles.summaryValue}>
                {project.issueCounter}
              </Text>
            </View>
            <View style={styles.summaryItem}>
              <Text selectable style={styles.summaryLabel}>
                Slug
              </Text>
              <Text
                selectable
                numberOfLines={1}
                style={styles.summaryValueText}
              >
                {project.slug}
              </Text>
            </View>
            <View style={styles.summaryItem}>
              <Text selectable style={styles.summaryLabel}>
                Status
              </Text>
              <Text selectable style={styles.summaryValueText}>
                {project.status}
              </Text>
            </View>
          </View>
        </View>
      ) : activeTab === "notes" ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text selectable style={styles.cardEyebrow}>
              Project notes
            </Text>
            <Text selectable style={styles.cardMeta}>
              Local only
            </Text>
          </View>
          <TextInput
            multiline
            value={notes}
            onChangeText={setNotes}
            placeholder="Track local notes, follow-up items, and handoff context here."
            placeholderTextColor={colors.warm[400]}
            style={styles.notesInput}
          />
        </View>
      ) : (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text selectable style={styles.cardEyebrow}>
              Project assistant
            </Text>
            <Text selectable style={styles.cardMeta}>
              Remote only
            </Text>
          </View>
          <View style={styles.assistantMessages}>
            {assistantMessages.length === 0 ? (
              <Text selectable style={styles.assistantEmpty}>
                Ask for risk, priorities, or what should happen next.
              </Text>
            ) : (
              assistantMessages.map((message, index) => (
                <View
                  key={`${message.role}-${index}`}
                  style={styles.assistantBubble}
                >
                  <Text selectable style={styles.assistantRole}>
                    {message.role === "user" ? "You" : "Assistant"}
                  </Text>
                  <Text selectable style={styles.assistantText}>
                    {message.content}
                  </Text>
                </View>
              ))
            )}
          </View>
          <View style={styles.assistantComposer}>
            <TextInput
              value={assistantDraft}
              onChangeText={setAssistantDraft}
              placeholder="Ask what matters here..."
              placeholderTextColor={colors.warm[400]}
              style={styles.assistantInput}
            />
            <Pressable
              onPress={() => void handleAskAssistant()}
              disabled={assistantDraft.trim().length === 0 || isAskingAssistant}
              style={[
                styles.sendButton,
                (assistantDraft.trim().length === 0 || isAskingAssistant) &&
                  styles.sendButtonDisabled,
              ]}
            >
              <Text selectable style={styles.sendLabel}>
                {isAskingAssistant ? "..." : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.warm[50] },
  content: { padding: 16, gap: 10, paddingBottom: 32 },
  loading: { flex: 1, backgroundColor: colors.warm[50] },
  headerCard: {
    gap: 2,
    borderRadius: 20,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.warm[300],
    backgroundColor: colors.white,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  identifier: {
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: colors.warm[400],
    fontWeight: "700",
  },
  title: {
    fontSize: 22,
    lineHeight: 26,
    color: colors.warm[900],
    fontWeight: "500",
  },
  meta: {
    fontSize: 12,
    color: colors.warm[500],
    fontVariant: ["tabular-nums"],
  },
  segmentedWrap: {
    flexDirection: "row",
    backgroundColor: colors.warm[100],
    borderRadius: 14,
    borderCurve: "continuous",
    padding: 4,
    gap: 4,
  },
  segmentedButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: "center",
  },
  segmentedButtonActive: { backgroundColor: colors.white },
  segmentedLabel: {
    fontSize: 11,
    color: colors.warm[700],
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 20,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.warm[300],
    padding: 14,
    gap: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardEyebrow: {
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: colors.warm[400],
    fontWeight: "700",
  },
  cardMeta: {
    fontSize: 10,
    color: colors.warm[400],
    textTransform: "uppercase",
    letterSpacing: 1.1,
  },
  summaryGrid: {
    gap: 10,
  },
  summaryItem: {
    gap: 2,
    paddingVertical: 2,
  },
  summaryLabel: {
    fontSize: 10,
    color: colors.warm[400],
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: "700",
  },
  summaryValue: {
    fontSize: 18,
    lineHeight: 22,
    color: colors.warm[900],
    fontVariant: ["tabular-nums"],
    fontWeight: "500",
  },
  summaryValueText: {
    fontSize: 15,
    lineHeight: 20,
    color: colors.warm[800],
  },
  notesInput: {
    minHeight: 180,
    textAlignVertical: "top",
    color: colors.warm[800],
    fontSize: 15,
    lineHeight: 22,
  },
  assistantMessages: { gap: 8 },
  assistantEmpty: { color: colors.warm[500], fontSize: 14, lineHeight: 20 },
  assistantBubble: {
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.warm[200],
    backgroundColor: colors.warm[50],
    padding: 10,
    gap: 4,
  },
  assistantRole: {
    fontSize: 9,
    color: colors.warm[400],
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  assistantText: { fontSize: 13, lineHeight: 19, color: colors.warm[800] },
  assistantComposer: { flexDirection: "row", gap: 8, alignItems: "center" },
  assistantInput: {
    flex: 1,
    minHeight: 42,
    borderWidth: 1,
    borderColor: colors.warm[300],
    borderRadius: 14,
    borderCurve: "continuous",
    backgroundColor: colors.warm[50],
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.warm[800],
    fontSize: 14,
  },
  sendButton: {
    minWidth: 66,
    minHeight: 42,
    borderRadius: 14,
    borderCurve: "continuous",
    backgroundColor: colors.accent[500],
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  sendButtonDisabled: { backgroundColor: colors.warm[300] },
  sendLabel: { color: colors.white, fontWeight: "700", fontSize: 13 },
});
