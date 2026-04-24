import type { Value } from "convex/values";

import { compareValues } from "@/runtime/db/compare";
import { evaluateFieldPath, evaluateValue } from "@/runtime/db/query";
import type { QueryDependency, StoredDocument } from "@/runtime/db/types";

type ProtocolChangeLike = {
  tableName: string;
  before: StoredDocument | null;
  after: StoredDocument | null;
};

function matchesRangeExpressions(
  doc: StoredDocument,
  range: Extract<QueryDependency, { type: "IndexRange" }>["range"],
): boolean {
  return range.every((filter) => {
    const result = evaluateFieldPath(filter.fieldPath, doc);
    const value = evaluateValue(filter.value) as Value | undefined;
    return filter.type === "Eq"
      ? compareValues(result, value) === 0
      : filter.type === "Gt"
        ? compareValues(result, value) > 0
        : filter.type === "Gte"
          ? compareValues(result, value) >= 0
          : filter.type === "Lt"
            ? compareValues(result, value) < 0
            : compareValues(result, value) <= 0;
  });
}

export function dependencyOverlapsChanges(
  dependency: QueryDependency,
  changes: ProtocolChangeLike[],
): boolean {
  return changes.some(({ tableName, before, after }) => {
    if (dependency.tableName !== tableName) {
      return false;
    }

    if (before === null && after === null) {
      return true;
    }

    if (dependency.type === "IndexRange") {
      return [before, after].some(
        (doc) => doc !== null && matchesRangeExpressions(doc, dependency.range),
      );
    }

    return true;
  });
}
