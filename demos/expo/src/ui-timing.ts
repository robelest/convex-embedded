import { useEffect, useRef } from "react";
import { InteractionManager } from "react-native";

const now = (): number =>
  globalThis.performance?.now?.() ?? Date.now();

interface PendingMark {
  startedAt: number;
  details?: Record<string, unknown>;
  reported?: boolean;
}

const marks = new Map<string, PendingMark>();

function fmt(ms: number): string {
  return ms < 1 ? `${ms.toFixed(2)}ms` : `${ms.toFixed(1)}ms`;
}

function emit(stage: string, label: string, ms: number, details?: Record<string, unknown>): void {
  const detailStr = details
    ? " " +
      Object.entries(details)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ")
    : "";
  console.log(`[ui-timing] ${stage} "${label}" ${fmt(ms)}${detailStr}`);
}

export function markUiClick(label: string, details?: Record<string, unknown>): void {
  const existing = marks.get(label);
  if (existing && !existing.reported) {
    emit("aborted", label, now() - existing.startedAt, existing.details);
  }
  marks.set(label, { startedAt: now(), details });
  emit("click", label, 0, details);
}

export function endUiMark(
  label: string,
  stage: string,
  extra?: Record<string, unknown>,
): number | null {
  const mark = marks.get(label);
  if (!mark || mark.reported) return null;
  const elapsed = now() - mark.startedAt;
  emit(stage, label, elapsed, extra);
  return elapsed;
}

export function clearUiMark(label: string): void {
  const mark = marks.get(label);
  if (mark) {
    mark.reported = true;
  }
  marks.delete(label);
}

/**
 * Measures the duration from `markUiClick(label)` until the React commit that
 * carries `value` to its first non-equal value, then again until the OS frame
 * paints (via requestAnimationFrame), then again until the next idle interaction.
 */
export function useTimeUiUpdate<T>(label: string, value: T): void {
  const previous = useRef<{ value: T; reportedCommit: boolean } | null>(null);
  useEffect(() => {
    if (previous.current && previous.current.value === value) return;
    const isFirst = previous.current === null;
    previous.current = { value, reportedCommit: true };
    if (isFirst) return;
    const mark = marks.get(label);
    if (!mark) return;
    const commitMs = now() - mark.startedAt;
    emit("commit", label, commitMs);
    requestAnimationFrame(() => {
      const paintMs = now() - mark.startedAt;
      emit("paint", label, paintMs);
      InteractionManager.runAfterInteractions(() => {
        const idleMs = now() - mark.startedAt;
        emit("idle", label, idleMs);
        clearUiMark(label);
      });
    });
  }, [label, value]);
}
