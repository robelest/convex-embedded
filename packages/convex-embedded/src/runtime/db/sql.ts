import type { FilterNode } from "@/runtime/db/query";
import type { Source } from "@/runtime/db/types";

export function sourceTableName(source: Source): string {
  return source.type === "FullTableScan"
    ? source.tableName
    : source.indexName.split(".")[0]!;
}

export function toJsonPath(fieldPath: string): string {
  const escaped = fieldPath.split(".").join(".").replace(/'/g, "''");
  return `$.${escaped}`;
}

export function fieldExpression(fieldPath: string): string {
  if (fieldPath === "_id") {
    return "id";
  }
  if (fieldPath === "_creationTime") {
    return "creation_time";
  }
  if (fieldPath === "__identityKey") {
    return "identity_key";
  }
  return `json_extract(data, '${toJsonPath(fieldPath)}')`;
}

export function buildOrderByClause(
  fields: string[],
  order: "asc" | "desc",
): string {
  const direction = order.toUpperCase();
  const parts = fields.map((field) => `${fieldExpression(field)} ${direction}`);
  if (!fields.includes("_id")) {
    parts.push(`id ${direction}`);
  }
  return parts.join(", ");
}

export function buildRangeWhereClause(input: {
  range: Source & { type: "IndexRange" };
  params: unknown[];
}): string[] {
  const clauses: string[] = [];
  for (const expression of input.range.range) {
    const operator =
      expression.type === "Eq"
        ? "="
        : expression.type === "Gt"
          ? ">"
          : expression.type === "Gte"
            ? ">="
            : expression.type === "Lt"
              ? "<"
              : "<=";
    clauses.push(`${fieldExpression(expression.fieldPath)} ${operator} ?`);
    input.params.push(expression.value);
  }
  return clauses;
}

export function buildFilterWhereClause(
  filter: FilterNode,
  params: unknown[],
): string | null {
  if (filter._tag === "And") {
    const children = filter.children
      .map((child) => buildFilterWhereClause(child, params))
      .filter((clause): clause is string => clause !== null);
    return children.length > 0 ? `(${children.join(" AND ")})` : null;
  }

  if (filter._tag === "Or") {
    const children = filter.children
      .map((child) => buildFilterWhereClause(child, params))
      .filter((clause): clause is string => clause !== null);
    return children.length > 0 ? `(${children.join(" OR ")})` : null;
  }

  if (filter._tag === "Not") {
    const child = buildFilterWhereClause(filter.child, params);
    return child ? `(NOT ${child})` : null;
  }

  const binaryOperators = {
    Eq: "=",
    Neq: "!=",
    Gt: ">",
    Gte: ">=",
    Lt: "<",
    Lte: "<=",
  } as const;

  if (
    filter._tag !== "Eq" &&
    filter._tag !== "Neq" &&
    filter._tag !== "Gt" &&
    filter._tag !== "Gte" &&
    filter._tag !== "Lt" &&
    filter._tag !== "Lte"
  ) {
    return null;
  }

  const left = filter.left;
  const right = filter.right;
  const op = binaryOperators[filter._tag];
  if (left._tag === "Field" && right._tag === "Literal") {
    params.push(right.value);
    return `${fieldExpression(left.fieldPath)} ${op} ?`;
  }
  if (left._tag === "Literal" && right._tag === "Field") {
    params.push(left.value);
    return `? ${op} ${fieldExpression(right.fieldPath)}`;
  }

  return null;
}
