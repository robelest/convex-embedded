import React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ensureTracingInstalled, type BufferedSpan } from "@/src/tracing";

type Tab = "summary" | "recent" | "boot";

interface AggRow {
  name: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
}

const SLOW_MS = 16;

export function TracingOverlay() {
  const handle = React.useMemo(() => ensureTracingInstalled(), []);
  const [open, setOpen] = React.useState(false);
  const [, setRev] = React.useState(0);
  const [tab, setTab] = React.useState<Tab>("summary");

  React.useEffect(() => {
    return handle.subscribe(() => {
      setRev((value) => value + 1);
    });
  }, [handle]);

  const spans = handle.getSpans();
  const stats = React.useMemo(() => aggregate(spans), [spans]);
  const slowCount = spans.filter((s) => s.durMs >= SLOW_MS).length;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={styles.fab}
        accessibilityLabel="Open tracing overlay"
      >
        <Text style={styles.fabText}>
          {`◐ ${spans.length}`}
          {slowCount > 0 ? ` · ${slowCount}!` : ""}
        </Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Tracing</Text>
            <View style={styles.headerButtons}>
              <Pressable
                style={styles.headerButton}
                onPress={() => handle.clearSpans()}
              >
                <Text style={styles.headerButtonText}>Clear</Text>
              </Pressable>
              <Pressable
                style={styles.headerButton}
                onPress={() => setOpen(false)}
              >
                <Text style={styles.headerButtonText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.tabs}>
            <TabButton
              label="Summary"
              active={tab === "summary"}
              onPress={() => setTab("summary")}
            />
            <TabButton
              label="Recent"
              active={tab === "recent"}
              onPress={() => setTab("recent")}
            />
            <TabButton
              label="Boot"
              active={tab === "boot"}
              onPress={() => setTab("boot")}
            />
          </View>

          {tab === "summary" ? (
            <SummaryView rows={stats} />
          ) : tab === "recent" ? (
            <RecentView spans={spans} />
          ) : (
            <BootView spans={spans} />
          )}
        </View>
      </Modal>
    </>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.tabButton, active && styles.tabButtonActive]}
    >
      <Text
        style={[styles.tabButtonText, active && styles.tabButtonTextActive]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SummaryView({ rows }: { rows: AggRow[] }) {
  return (
    <ScrollView style={styles.body}>
      <View style={styles.rowHeader}>
        <Text style={[styles.rowText, styles.rowName]}>name</Text>
        <Text style={[styles.rowText, styles.rowCol]}>n</Text>
        <Text style={[styles.rowText, styles.rowCol]}>p50</Text>
        <Text style={[styles.rowText, styles.rowCol]}>p95</Text>
        <Text style={[styles.rowText, styles.rowCol]}>max</Text>
      </View>
      {rows.map((row) => (
        <View key={row.name} style={styles.row}>
          <Text style={[styles.rowText, styles.rowName]} numberOfLines={1}>
            {row.name.replace("convex-embedded.", "")}
          </Text>
          <Text style={[styles.rowText, styles.rowCol]}>{row.count}</Text>
          <Text
            style={[
              styles.rowText,
              styles.rowCol,
              row.p50Ms >= SLOW_MS && styles.slow,
            ]}
          >
            {row.p50Ms.toFixed(0)}
          </Text>
          <Text
            style={[
              styles.rowText,
              styles.rowCol,
              row.p95Ms >= SLOW_MS && styles.slow,
            ]}
          >
            {row.p95Ms.toFixed(0)}
          </Text>
          <Text
            style={[
              styles.rowText,
              styles.rowCol,
              row.maxMs >= SLOW_MS && styles.slow,
            ]}
          >
            {row.maxMs.toFixed(0)}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function RecentView({ spans }: { spans: BufferedSpan[] }) {
  const reversed = spans.slice().reverse();
  return (
    <ScrollView style={styles.body}>
      {reversed.map((span) => (
        <SpanRow key={span.spanId} span={span} />
      ))}
    </ScrollView>
  );
}

function BootView({ spans }: { spans: BufferedSpan[] }) {
  const bootNames = new Set([
    "convex-embedded.attachPlatformStorage",
    "convex-embedded.platform.openStorage",
    "convex-embedded.db.hydrate",
    "convex-embedded.db.hydrate.fetch",
    "convex-embedded.db.hydrate.populate",
    "convex-embedded.db.hydrate.rebuildIndexes",
    "convex-embedded.db.rebuildAllIndexes",
    "convex-embedded.db.rebuildAllSearchIndexes",
    "convex-embedded.db.rebuildAllVectorIndexes",
    "convex-embedded.db.rebuildTableIndexes",
    "convex-embedded.db.rebuildTableSearchIndexes",
    "convex-embedded.db.rebuildTableVectorIndexes",
    "convex-embedded.runLoadPass",
    "convex-embedded.checkPendingReplay",
    "convex-embedded.loadReplayMetadata",
    "convex-embedded.runLocalMigrations",
    "convex-embedded.initializeIdentity",
    "convex-embedded.resumePersistedState",
    "convex-embedded.resolveAll",
    "convex-embedded.resolveTableFx",
  ]);
  const bootSpans = spans.filter((s) => bootNames.has(s.name));
  return (
    <ScrollView style={styles.body}>
      {bootSpans.map((span) => (
        <SpanRow key={span.spanId} span={span} indent />
      ))}
    </ScrollView>
  );
}

function SpanRow({ span, indent }: { span: BufferedSpan; indent?: boolean }) {
  const slow = span.durMs >= SLOW_MS;
  const attrs = renderAttrs(span.attributes);
  return (
    <View
      style={[
        styles.spanRow,
        indent && styles.spanRowIndent,
        slow && styles.spanRowSlow,
      ]}
    >
      <View style={styles.spanHeader}>
        <Text style={styles.spanName} numberOfLines={1}>
          {span.name.replace("convex-embedded.", "")}
        </Text>
        <Text style={[styles.spanDur, slow && styles.slow]}>
          {span.durMs.toFixed(1)}ms
        </Text>
      </View>
      {attrs ? (
        <Text style={styles.spanAttrs} numberOfLines={2}>
          {attrs}
        </Text>
      ) : null}
      {span.status === "error" && span.error ? (
        <Text style={styles.spanError} numberOfLines={2}>
          ✗ {span.error}
        </Text>
      ) : null}
    </View>
  );
}

function renderAttrs(attrs: Record<string, unknown>): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      const short = key.replace(/^convex\./, "");
      return `${short}=${formatValue(value)}`;
    })
    .join(" ");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") {
    return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

function aggregate(spans: BufferedSpan[]): AggRow[] {
  const groups = new Map<string, number[]>();
  for (const span of spans) {
    const arr = groups.get(span.name);
    if (arr) {
      arr.push(span.durMs);
    } else {
      groups.set(span.name, [span.durMs]);
    }
  }
  const rows: AggRow[] = [];
  for (const [name, durations] of groups) {
    const sorted = durations.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    rows.push({
      name,
      count: sorted.length,
      totalMs: sum,
      minMs: sorted[0]!,
      maxMs: sorted[sorted.length - 1]!,
      lastMs: durations[durations.length - 1]!,
      p50Ms: p50,
      p95Ms: p95,
    });
  }
  rows.sort((a, b) => b.maxMs - a.maxMs);
  return rows;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(p * (sortedAsc.length - 1))),
  );
  return sortedAsc[rank]!;
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    bottom: 32,
    right: 12,
    backgroundColor: "rgba(20,20,20,0.85)",
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 12,
    zIndex: 9999,
  },
  fabText: {
    color: "#ffd1c1",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
  },
  sheet: {
    flex: 1,
    backgroundColor: "#0d0d0d",
    paddingTop: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  title: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  headerButtons: {
    flexDirection: "row",
    gap: 8,
  },
  headerButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: "#262626",
    borderRadius: 8,
  },
  headerButtonText: {
    color: "#f1f1f1",
    fontSize: 12,
    fontWeight: "600",
  },
  tabs: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#1f1f1f",
    paddingHorizontal: 16,
  },
  tabButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 4,
  },
  tabButtonActive: {
    borderBottomWidth: 2,
    borderBottomColor: "#c25d3a",
  },
  tabButtonText: {
    color: "#888",
    fontSize: 13,
    fontWeight: "600",
  },
  tabButtonTextActive: {
    color: "#fff",
  },
  body: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  rowHeader: {
    flexDirection: "row",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  row: {
    flexDirection: "row",
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: "#181818",
  },
  rowText: {
    color: "#cfcfcf",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  rowName: {
    flex: 1,
    paddingRight: 8,
  },
  rowCol: {
    width: 44,
    textAlign: "right",
  },
  slow: {
    color: "#ff8a65",
    fontWeight: "700",
  },
  spanRow: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#181818",
  },
  spanRowIndent: {
    paddingLeft: 4,
  },
  spanRowSlow: {
    backgroundColor: "rgba(194,93,58,0.07)",
  },
  spanHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  spanName: {
    color: "#e6e6e6",
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
    paddingRight: 8,
  },
  spanDur: {
    color: "#cfcfcf",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
  },
  spanAttrs: {
    color: "#7a7a7a",
    fontSize: 10,
    marginTop: 2,
  },
  spanError: {
    color: "#ff5d5d",
    fontSize: 11,
    marginTop: 2,
  },
});
