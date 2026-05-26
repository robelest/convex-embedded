import type { Definition } from "@/shared/schema";

export function unwrapSchemaField(field: unknown): unknown {
  if (
    typeof field === "object" &&
    field !== null &&
    "validator" in field &&
    typeof (field as { validator?: unknown }).validator !== "undefined"
  ) {
    return (field as { validator: unknown }).validator;
  }
  return field;
}

function rewriteKnownIdsResult(
  value: unknown,
  field: unknown,
  localId: string,
  remoteId: string,
): { value: unknown; changed: boolean } {
  const unwrappedField = unwrapSchemaField(field);

  if (value === null || value === undefined) {
    return { value, changed: false };
  }

  if (typeof unwrappedField === "string") {
    return unwrappedField === "id" && value === localId
      ? { value: remoteId, changed: true }
      : { value, changed: false };
  }

  if (typeof unwrappedField !== "object") {
    return { value, changed: false };
  }

  const validator = unwrappedField as Record<string, unknown> & {
    kind?: string;
  };
  switch (validator.kind) {
    case "id":
      return value === localId
        ? { value: remoteId, changed: true }
        : { value, changed: false };
    case "array": {
      if (!Array.isArray(value)) {
        return { value, changed: false };
      }
      let changed = false;
      const items = value.map((entry) => {
        const rewritten = rewriteKnownIdsResult(
          entry,
          validator.element,
          localId,
          remoteId,
        );
        changed = changed || rewritten.changed;
        return rewritten.value;
      });
      return { value: changed ? items : value, changed };
    }
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { value, changed: false };
      }
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => {
          const rewritten = rewriteKnownIdsResult(
            entryValue,
            validator.value,
            localId,
            remoteId,
          );
          changed = changed || rewritten.changed;
          return [key, rewritten.value];
        }),
      );
      return { value: changed ? next : value, changed };
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { value, changed: false };
      }
      const fields = validator.fields as Record<string, unknown> | undefined;
      if (!fields) {
        return { value, changed: false };
      }
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(fields).map(([key, entryField]) => {
          const rewritten = rewriteKnownIdsResult(
            (value as Record<string, unknown>)[key],
            entryField,
            localId,
            remoteId,
          );
          changed = changed || rewritten.changed;
          return [key, rewritten.value];
        }),
      );
      return {
        value: changed
          ? { ...(value as Record<string, unknown>), ...next }
          : value,
        changed,
      };
    }
    case "union": {
      const members = validator.members;
      if (!Array.isArray(members)) {
        return { value, changed: false };
      }
      for (const member of members) {
        const rewritten = rewriteKnownIdsResult(
          value,
          member,
          localId,
          remoteId,
        );
        if (rewritten.changed) {
          return rewritten;
        }
      }
      return { value, changed: false };
    }
    case "optional":
      return rewriteKnownIdsResult(value, validator.field, localId, remoteId);
    default:
      return { value, changed: false };
  }
}

function rewriteKnownIds(
  value: unknown,
  field: unknown,
  localId: string,
  remoteId: string,
): unknown {
  return rewriteKnownIdsResult(value, field, localId, remoteId).value;
}

export function rewriteDocumentToCanonical(input: {
  doc: Record<string, unknown>;
  schema: Definition;
  localId: string;
  remoteId: string;
  rewriteOwnId: boolean;
}): Record<string, unknown> {
  const next: Record<string, unknown> = { ...input.doc };
  for (const [fieldName, field] of Object.entries(input.schema.getShape())) {
    next[fieldName] = rewriteKnownIds(
      next[fieldName],
      field,
      input.localId,
      input.remoteId,
    );
  }
  if (input.rewriteOwnId && next._id === input.localId) {
    next._id = input.remoteId;
  }
  return next;
}

export function canonicalizeMappedCreateTable(input: {
  docs: Array<Record<string, unknown>>;
  schema: Definition;
  localId: string;
  remoteId: string;
  rewriteOwnId: boolean;
  tableName: string;
}): {
  changed: boolean;
  documents: Array<Record<string, unknown>>;
} {
  let changed = false;
  const documents: Array<Record<string, unknown>> = [];
  const canonicalById = new Map<
    string,
    {
      index: number;
      fromLocalAlias: boolean;
    }
  >();

  for (const doc of input.docs) {
    const rewritten = rewriteDocumentToCanonical({
      doc,
      schema: input.schema,
      localId: input.localId,
      remoteId: input.remoteId,
      rewriteOwnId: input.rewriteOwnId,
    });
    changed = changed || rewritten !== doc;

    const finalId = rewritten._id;
    if (typeof finalId !== "string") {
      documents.push(rewritten);
      continue;
    }

    const fromLocalAlias =
      input.rewriteOwnId &&
      doc._id === input.localId &&
      finalId === input.remoteId;
    const existing = canonicalById.get(finalId);
    if (!existing) {
      canonicalById.set(finalId, {
        index: documents.length,
        fromLocalAlias,
      });
      documents.push(rewritten);
      continue;
    }

    if (fromLocalAlias && !existing.fromLocalAlias) {
      documents[existing.index] = rewritten;
      canonicalById.set(finalId, {
        index: existing.index,
        fromLocalAlias: true,
      });
      changed = true;
      continue;
    }

    if (!fromLocalAlias && existing.fromLocalAlias) {
      changed = true;
      continue;
    }

    throw new Error(
      `[convex-embedded] Canonicalizing ${input.localId} -> ${input.remoteId} in table "${input.tableName}" produced multiple documents with _id "${finalId}".`,
    );
  }

  return { changed, documents };
}
