import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function temporaryDatabasePath(name: string): string {
  const tmpRoot = join(process.cwd(), "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  return join(tmpRoot, `${name}.sqlite`);
}
