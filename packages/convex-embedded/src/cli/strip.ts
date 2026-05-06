import ts from "typescript";

const REMOTE_ONLY_PACKAGE_PREFIX = "@robelest/convex-embedded";

function isRemoteOnlyPackage(spec: string): boolean {
  return (
    spec === REMOTE_ONLY_PACKAGE_PREFIX ||
    spec.startsWith(`${REMOTE_ONLY_PACKAGE_PREFIX}/`)
  );
}

export interface StripResult {
  source: string;
  hasAnyExports: boolean;
  removedExports: string[];
  removedImports: string[];
  removedTopLevelBindings: string[];
}

export interface StripInput {
  source: string;
  fileName?: string;
}

/**
 * Remove every `export const X = remoteOnly(...)` declaration from the
 * source plus any top-level imports / declarations whose only references
 * are inside those removed subtrees.
 *
 * Conservative scope analysis: works at module scope without a
 * `ts.TypeChecker`. Bindings shadowed by inner scopes may have false
 * matches and stay in the output, which is the safe direction (an
 * unused import survives; nothing important is removed).
 */
export function stripRemoteOnlyExports(input: StripInput): StripResult {
  const fileName = input.fileName ?? "input.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    input.source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    detectScriptKind(fileName),
  );

  const remoteOnlyNames = findRemoteOnlyLocalNames(sourceFile);
  if (
    remoteOnlyNames.named.size === 0 &&
    remoteOnlyNames.namespaced.size === 0
  ) {
    return {
      source: input.source,
      hasAnyExports: hasAnyExport(sourceFile),
      removedExports: [],
      removedImports: [],
      removedTopLevelBindings: [],
    };
  }

  const removedRanges: Array<{ start: number; end: number }> = [];
  const removedExports: string[] = [];
  const explicitlyRemovedStmts = new Set<ts.Statement>();

  for (const stmt of sourceFile.statements) {
    const exportName = remoteOnlyExportName(stmt, remoteOnlyNames);
    if (exportName !== null) {
      removedRanges.push({ start: stmt.getStart(sourceFile), end: stmt.getEnd() });
      removedExports.push(exportName);
      explicitlyRemovedStmts.add(stmt);
    }
  }

  if (removedExports.length === 0) {
    return {
      source: input.source,
      hasAnyExports: hasAnyExport(sourceFile),
      removedExports: [],
      removedImports: [],
      removedTopLevelBindings: [],
    };
  }

  const topLevelBindings = collectTopLevelBindings(sourceFile);

  let removedBindings: Set<string>;
  let iterations = 0;
  do {
    removedBindings = computeRemoveableBindings({
      sourceFile,
      bindings: topLevelBindings,
      removedRanges,
    });
    if (removedBindings.size === 0) break;
    for (const name of removedBindings) {
      const binding = topLevelBindings.get(name);
      if (!binding) continue;
      removedRanges.push({
        start: binding.range.start,
        end: binding.range.end,
      });
      explicitlyRemovedStmts.add(binding.statement);
      topLevelBindings.delete(name);
    }
    iterations++;
  } while (removedBindings.size > 0 && iterations < 16);

  const importsRemoved: string[] = [];
  const otherBindingsRemoved: string[] = [];
  for (const stmt of explicitlyRemovedStmts) {
    if (ts.isImportDeclaration(stmt)) {
      importsRemoved.push(...importLocalNames(stmt));
    } else if (
      ts.isVariableStatement(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt)
    ) {
      const names = bindingsFromStatement(stmt);
      for (const n of names) {
        if (!removedExports.includes(n)) otherBindingsRemoved.push(n);
      }
    }
  }

  removedRanges.sort((a, b) => a.start - b.start);
  const stripped = sliceOutRanges(input.source, removedRanges);
  const finalSource = collapseBlankLines(stripped);

  return {
    source: finalSource,
    hasAnyExports: hasAnyExport(parse(finalSource, fileName)),
    removedExports,
    removedImports: importsRemoved,
    removedTopLevelBindings: otherBindingsRemoved,
  };
}

interface RemoteOnlyNames {
  named: Set<string>;
  namespaced: Set<string>;
}

function findRemoteOnlyLocalNames(
  sourceFile: ts.SourceFile,
): RemoteOnlyNames {
  const named = new Set<string>();
  const namespaced = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpec)) continue;
    if (!isRemoteOnlyPackage(moduleSpec.text)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaced.add(bindings.name.text);
    } else if (ts.isNamedImports(bindings)) {
      for (const elem of bindings.elements) {
        if (elem.isTypeOnly) continue;
        const importedName = elem.propertyName?.text ?? elem.name.text;
        if (importedName === "remoteOnly") {
          named.add(elem.name.text);
        }
      }
    }
  }
  return { named, namespaced };
}

function remoteOnlyExportName(
  stmt: ts.Statement,
  names: RemoteOnlyNames,
): string | null {
  if (ts.isVariableStatement(stmt)) {
    if (!hasExportModifier(stmt)) return null;
    if (stmt.declarationList.declarations.length !== 1) return null;
    const decl = stmt.declarationList.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) return null;
    if (!decl.initializer) return null;
    if (!isRemoteOnlyCall(decl.initializer, names)) return null;
    return decl.name.text;
  }
  if (ts.isExportAssignment(stmt)) {
    if (stmt.isExportEquals) return null;
    if (!isRemoteOnlyCall(stmt.expression, names)) return null;
    return "default";
  }
  return null;
}

function isRemoteOnlyCall(
  expr: ts.Expression,
  names: RemoteOnlyNames,
): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (ts.isIdentifier(callee)) {
    return names.named.has(callee.text);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return (
      ts.isIdentifier(callee.expression) &&
      names.namespaced.has(callee.expression.text) &&
      callee.name.text === "remoteOnly"
    );
  }
  return false;
}

function hasExportModifier(stmt: ts.Statement): boolean {
  const modifiers = (stmt as { modifiers?: readonly ts.ModifierLike[] }).modifiers;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

interface TopLevelBinding {
  name: string;
  statement: ts.Statement;
  range: { start: number; end: number };
  isImport: boolean;
  isTypeOnly: boolean;
  isExported: boolean;
  isSideEffectImport: boolean;
}

function collectTopLevelBindings(
  sourceFile: ts.SourceFile,
): Map<string, TopLevelBinding> {
  const bindings = new Map<string, TopLevelBinding>();
  for (const stmt of sourceFile.statements) {
    const range = {
      start: stmt.getStart(sourceFile),
      end: stmt.getEnd(),
    };
    if (ts.isImportDeclaration(stmt)) {
      const isTypeOnly = stmt.importClause?.isTypeOnly === true;
      if (!stmt.importClause) {
        // Side-effect import; preserve unconditionally
        continue;
      }
      const isSideEffect = false;
      for (const name of importLocalNames(stmt)) {
        bindings.set(name, {
          name,
          statement: stmt,
          range,
          isImport: true,
          isTypeOnly,
          isExported: false,
          isSideEffectImport: isSideEffect,
        });
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      const exported = hasExportModifier(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          bindings.set(decl.name.text, {
            name: decl.name.text,
            statement: stmt,
            range,
            isImport: false,
            isTypeOnly: false,
            isExported: exported,
            isSideEffectImport: false,
          });
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (!stmt.name) continue;
      bindings.set(stmt.name.text, {
        name: stmt.name.text,
        statement: stmt,
        range,
        isImport: false,
        isTypeOnly: false,
        isExported: hasExportModifier(stmt),
        isSideEffectImport: false,
      });
      continue;
    }
  }
  return bindings;
}

function importLocalNames(stmt: ts.ImportDeclaration): string[] {
  const out: string[] = [];
  const clause = stmt.importClause;
  if (!clause) return out;
  if (clause.name) out.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (!bindings) return out;
  if (ts.isNamespaceImport(bindings)) {
    out.push(bindings.name.text);
  } else if (ts.isNamedImports(bindings)) {
    for (const elem of bindings.elements) {
      out.push(elem.name.text);
    }
  }
  return out;
}

function bindingsFromStatement(stmt: ts.Statement): string[] {
  if (ts.isVariableStatement(stmt)) {
    const out: string[] = [];
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) out.push(decl.name.text);
    }
    return out;
  }
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    return stmt.name ? [stmt.name.text] : [];
  }
  return [];
}

function computeRemoveableBindings(input: {
  sourceFile: ts.SourceFile;
  bindings: Map<string, TopLevelBinding>;
  removedRanges: Array<{ start: number; end: number }>;
}): Set<string> {
  const removeable = new Set<string>();
  for (const [name, binding] of input.bindings) {
    // Type-only imports never affect runtime; preserve them.
    if (binding.isImport && binding.isTypeOnly) continue;
    // Anything still exported needs to stay (it's part of the public surface).
    if (binding.isExported) continue;
    // The binding's own declaration is "inside" its range; we count
    // references that fall *outside* the removed ranges AND outside the
    // binding's own declaration range.
    let referencedFromKept = false;
    visitIdentifiers(input.sourceFile, (idNode) => {
      if (idNode.text !== name) return;
      const pos = idNode.getStart(input.sourceFile);
      if (pos >= binding.range.start && pos < binding.range.end) return;
      for (const range of input.removedRanges) {
        if (pos >= range.start && pos < range.end) return;
      }
      referencedFromKept = true;
    });
    if (!referencedFromKept) {
      removeable.add(name);
    }
  }
  return removeable;
}

function visitIdentifiers(
  node: ts.Node,
  visitor: (id: ts.Identifier) => void,
): void {
  if (ts.isIdentifier(node)) {
    visitor(node);
  }
  ts.forEachChild(node, (child) => visitIdentifiers(child, visitor));
}

function hasAnyExport(sourceFile: ts.SourceFile): boolean {
  for (const stmt of sourceFile.statements) {
    if (
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt)
    ) {
      return true;
    }
    if (
      hasExportModifier(stmt) &&
      (ts.isVariableStatement(stmt) ||
        ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt))
    ) {
      return true;
    }
  }
  return false;
}

function sliceOutRanges(
  source: string,
  ranges: Array<{ start: number; end: number }>,
): string {
  if (ranges.length === 0) return source;
  const merged = mergeRanges(ranges);
  let out = "";
  let cursor = 0;
  for (const r of merged) {
    out += source.slice(cursor, r.start);
    cursor = r.end;
  }
  out += source.slice(cursor);
  return out;
}

function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

function collapseBlankLines(source: string): string {
  return source.replace(/\n{3,}/g, "\n\n");
}

function detectScriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js")) return ts.ScriptKind.JS;
  if (fileName.endsWith(".mjs")) return ts.ScriptKind.JS;
  if (fileName.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    detectScriptKind(fileName),
  );
}
