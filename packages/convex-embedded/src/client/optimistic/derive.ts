export interface PatchEffect {
  kind: "patch";
  table: string;
  id: string;
  patch: Record<string, unknown>;
}

export interface InsertEffect {
  kind: "insert";
  table: string;
  doc: Record<string, unknown>;
}

export interface DeleteEffect {
  kind: "delete";
  table: string;
  id: string;
}

export type EffectDescriptor = PatchEffect | InsertEffect | DeleteEffect;

interface DeriveInput {
  refName: string;
  args: Record<string, unknown>;
  knownTables?: ReadonlySet<string>;
}

const CREATE_RE = /(?:create|add|insert)$/i;
const DELETE_RE = /(?:delete|remove|destroy)$/i;
const ID_FIELD_RE = /^(.*)Id$/;

export function deriveOptimisticEffect(
  input: DeriveInput,
): EffectDescriptor | null {
  const args = input.args ?? {};
  const idFields: Array<{ field: string; tableHint: string; value: string }> =
    [];

  for (const [field, value] of Object.entries(args)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const match = ID_FIELD_RE.exec(field);
    if (!match) continue;
    const stem = match[1];
    if (!stem) continue;
    const tableHint = inferTable(stem, input.knownTables);
    if (!tableHint) continue;
    idFields.push({ field, tableHint, value });
  }

  const localName = trailingSegment(input.refName);
  const looksCreate = CREATE_RE.test(localName);
  const looksDelete = DELETE_RE.test(localName);

  if (idFields.length === 1) {
    const id = idFields[0]!;
    if (looksDelete) {
      return { kind: "delete", table: id.tableHint, id: id.value };
    }
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(args)) {
      if (field === id.field) continue;
      if (value === undefined) continue;
      patch[field] = value;
    }
    if (Object.keys(patch).length === 0) {
      return null;
    }
    return { kind: "patch", table: id.tableHint, id: id.value, patch };
  }

  if (idFields.length === 0 && looksCreate) {
    const tableHint = guessInsertTable(
      localName,
      input.knownTables,
      input.refName,
    );
    if (!tableHint) return null;
    const doc: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(args)) {
      if (value === undefined) continue;
      doc[field] = value;
    }
    if (Object.keys(doc).length === 0) return null;
    return { kind: "insert", table: tableHint, doc };
  }

  return null;
}

function trailingSegment(refName: string): string {
  const lastSlash = refName.lastIndexOf("/");
  const tail = lastSlash >= 0 ? refName.slice(lastSlash + 1) : refName;
  const lastColon = tail.lastIndexOf(":");
  return lastColon >= 0 ? tail.slice(lastColon + 1) : tail;
}

function inferTable(
  stem: string,
  knownTables: ReadonlySet<string> | undefined,
): string | null {
  const candidates = pluralCandidates(stem);
  if (knownTables) {
    for (const candidate of candidates) {
      if (knownTables.has(candidate)) return candidate;
    }
    return null;
  }
  return candidates[0] ?? null;
}

function guessInsertTable(
  refLocalName: string,
  knownTables: ReadonlySet<string> | undefined,
  refName: string,
): string | null {
  const moduleName = refName.includes(":")
    ? refName.slice(0, refName.lastIndexOf(":"))
    : "";
  const moduleSegment = moduleName.includes("/")
    ? moduleName.slice(moduleName.lastIndexOf("/") + 1)
    : moduleName;
  if (moduleSegment && knownTables) {
    if (knownTables.has(moduleSegment)) return moduleSegment;
    const candidates = pluralCandidates(moduleSegment);
    for (const candidate of candidates) {
      if (knownTables.has(candidate)) return candidate;
    }
  }
  const stripped = refLocalName.replace(CREATE_RE, "");
  if (stripped) {
    const inferred = inferTable(stripped, knownTables);
    if (inferred) return inferred;
  }
  return moduleSegment || null;
}

function pluralCandidates(stem: string): string[] {
  if (!stem) return [];
  const lower = stem.charAt(0).toLowerCase() + stem.slice(1);
  const variants = new Set<string>();
  variants.add(lower);
  if (lower.endsWith("s")) {
    variants.add(lower.slice(0, -1));
  } else if (lower.endsWith("y")) {
    variants.add(lower.slice(0, -1) + "ies");
  } else {
    variants.add(lower + "s");
  }
  return Array.from(variants);
}
