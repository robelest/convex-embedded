import type { Source } from "@/runtime/db/types";

export function sourceTableName(source: Source): string {
  return source.type === "FullTableScan"
    ? source.tableName
    : source.indexName.split(".")[0]!;
}
