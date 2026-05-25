import type { SchemaTable } from "@/devtools/core/types";
import {
  button,
  el,
  empty,
  errorMessage,
  formatCell,
  palette,
  text,
  textarea,
} from "@/devtools/ui/dom";
import { jsonTree } from "@/devtools/ui/jsonTree";
import type { DevtoolsTab } from "@/devtools/ui/tab";

const PAGE_SIZE = 50;
const CELL_MAX = 80;

function isSystemTable(name: string): boolean {
  return name.startsWith("_");
}

function caret(expanded: boolean): HTMLElement {
  return text(expanded ? "▾" : "▸", {
    color: palette.fgDim,
    display: "inline-block",
    width: "12px",
    flexShrink: "0",
  });
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  const set = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) set.add(key);
  const rank = (key: string): number =>
    key === "_id" ? 0 : key === "_creationTime" ? 1 : 2;
  return [...set].sort(
    (left, right) => rank(left) - rank(right) || left.localeCompare(right),
  );
}

function truncate(value: string): string {
  return value.length > CELL_MAX ? `${value.slice(0, CELL_MAX)}…` : value;
}

function cellNode(value: unknown): HTMLElement {
  if (value !== null && typeof value === "object") {
    return text(truncate(formatCell(value)), { color: palette.fgMuted });
  }
  return text(truncate(formatCell(value)), {
    color: value === null || value === undefined ? palette.fgDim : palette.fg,
  });
}

export const dataTab: DevtoolsTab = {
  id: "data",
  name: "Data",
  countView: "data",
  count: (source) =>
    source.getSnapshot("data").filter((table) => !isSystemTable(table.name))
      .length,
  mount: (host, source) => {
    let selected: string | null = null;
    let rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let isDone = true;
    let loading = false;
    let showSystem = false;
    let selectedRowId: string | null = null;
    let editing = false;
    let editError = "";
    let schemaExpanded = false;

    const listEl = el("div", {
      style: {
        width: "220px",
        flexShrink: "0",
        overflow: "auto",
        borderRight: `1px solid ${palette.border}`,
        background: palette.bgAlt,
      },
    });
    const mainEl = el("div", {
      style: { flex: "1", minWidth: "0", overflow: "auto" },
    });
    const detailEl = el("div", {
      style: {
        width: "40%",
        maxWidth: "520px",
        flexShrink: "0",
        overflow: "auto",
        borderLeft: `1px solid ${palette.border}`,
        background: palette.bg,
        display: "none",
      },
    });
    const root = el(
      "div",
      { style: { display: "flex", height: "100%", minHeight: "0" } },
      [listEl, mainEl, detailEl],
    );
    host.appendChild(root);

    const rowObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            selected !== null &&
            !isDone &&
            !loading
          ) {
            void loadRows(false);
          }
        }
      },
      { root: mainEl, rootMargin: "200px" },
    );

    const tableRow = (name: string, rowCount: number): HTMLElement =>
      el(
        "div",
        {
          onClick: () => {
            selected = name;
            selectedRowId = null;
            editing = false;
            renderList();
            void loadRows(true);
          },
          style: {
            display: "flex",
            justifyContent: "space-between",
            gap: "8px",
            padding: "5px 10px",
            cursor: "pointer",
            font: `12px ${palette.mono}`,
            background: name === selected ? palette.bgRaised : "transparent",
            color: name === selected ? palette.fg : palette.fgMuted,
          },
        },
        [
          text(name, { overflow: "hidden", textOverflow: "ellipsis" }),
          text(String(rowCount), { color: palette.fgDim, flexShrink: "0" }),
        ],
      );

    function renderList(): void {
      listEl.textContent = "";
      listEl.appendChild(
        el("div", {
          text: "Tables",
          style: {
            font: `11px ${palette.sans}`,
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: palette.fgMuted,
            padding: "10px 10px 6px",
          },
        }),
      );
      const tables = source.getSnapshot("data");
      const user = tables.filter((table) => !isSystemTable(table.name));
      const system = tables.filter((table) => isSystemTable(table.name));
      if (user.length === 0) listEl.appendChild(empty("No tables."));
      for (const table of user) {
        listEl.appendChild(tableRow(table.name, table.rowCount));
      }
      if (system.length > 0) {
        listEl.appendChild(
          el(
            "div",
            {
              onClick: () => {
                showSystem = !showSystem;
                renderList();
              },
              style: {
                display: "flex",
                alignItems: "center",
                gap: "4px",
                padding: "6px 10px",
                cursor: "pointer",
                font: `12px ${palette.mono}`,
                color: palette.fgMuted,
              },
            },
            [caret(showSystem), text(`System tables (${system.length})`)],
          ),
        );
        if (showSystem) {
          for (const table of system) {
            listEl.appendChild(tableRow(table.name, table.rowCount));
          }
        }
      }
    }

    function schemaBlock(): HTMLElement | null {
      if (selected === null) return null;
      const schema = source
        .getSnapshot("schema")
        .find((entry: SchemaTable) => entry.name === selected);
      if (!schema || schema.indexes.length === 0) return null;

      const wrap = el("div", { style: { padding: "0 12px 8px" } });
      wrap.appendChild(
        el(
          "div",
          {
            onClick: () => {
              schemaExpanded = !schemaExpanded;
              renderMain();
            },
            style: {
              display: "flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 0",
              cursor: "pointer",
              font: `11px ${palette.sans}`,
              color: palette.fgMuted,
            },
          },
          [caret(schemaExpanded), text(`Indexes (${schema.indexes.length})`)],
        ),
      );
      if (schemaExpanded) {
        const list = el("div", { style: { paddingLeft: "16px" } });
        for (const index of schema.indexes) {
          list.appendChild(
            el(
              "div",
              {
                style: {
                  display: "flex",
                  gap: "12px",
                  padding: "2px 0",
                  font: `11px ${palette.mono}`,
                },
              },
              [
                text(index.name, {
                  color: palette.accent,
                  minWidth: "200px",
                  flexShrink: "0",
                }),
                text(index.fields.join(", "), { color: palette.fgMuted }),
              ],
            ),
          );
        }
        wrap.appendChild(list);
      }
      return wrap;
    }

    function renderMain(): void {
      mainEl.textContent = "";
      if (selected === null) {
        mainEl.appendChild(empty("Select a table to browse its rows."));
        return;
      }
      const meta = source
        .getSnapshot("data")
        .find((table) => table.name === selected);
      mainEl.appendChild(
        el(
          "div",
          {
            style: {
              display: "flex",
              gap: "8px",
              alignItems: "baseline",
              padding: "10px 12px 6px",
            },
          },
          [
            text(selected, { font: `13px ${palette.mono}`, color: palette.fg }),
            text(`${meta?.rowCount ?? 0} rows`, { color: palette.fgDim }),
            text(`${rows.length} loaded`, { color: palette.fgDim }),
          ],
        ),
      );
      const schema = schemaBlock();
      if (schema) mainEl.appendChild(schema);

      if (rows.length === 0) {
        mainEl.appendChild(loading ? empty("Loading…") : empty("No rows."));
        return;
      }

      const cols = columnsOf(rows);
      const header = el(
        "tr",
        {},
        cols.map((col) =>
          el("th", {
            text: col,
            style: {
              textAlign: "left",
              padding: "6px 10px",
              color: palette.fgMuted,
              fontWeight: "600",
              fontSize: "11px",
              borderBottom: `1px solid ${palette.border}`,
              position: "sticky",
              top: "0",
              background: palette.bgAlt,
              whiteSpace: "nowrap",
            },
          }),
        ),
      );
      const body = el(
        "tbody",
        {},
        rows.map((rowDoc) => {
          const id = String(rowDoc._id);
          return el(
            "tr",
            {
              onClick: () => {
                selectedRowId = id;
                editing = false;
                editError = "";
                renderDetail();
                renderMain();
              },
              style: {
                cursor: "pointer",
                background:
                  id === selectedRowId ? palette.bgRaised : "transparent",
              },
            },
            cols.map((col) =>
              el(
                "td",
                {
                  style: {
                    padding: "5px 10px",
                    borderBottom: `1px solid ${palette.bgAlt}`,
                    whiteSpace: "nowrap",
                    maxWidth: "320px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                },
                cellNode(rowDoc[col]),
              ),
            ),
          );
        }),
      );
      mainEl.appendChild(
        el(
          "table",
          {
            style: {
              borderCollapse: "collapse",
              font: `12px ${palette.mono}`,
              minWidth: "100%",
            },
          },
          [el("thead", {}, header), body],
        ),
      );

      if (loading) {
        mainEl.appendChild(
          el("div", {
            text: "Loading…",
            style: {
              padding: "10px 12px",
              color: palette.fgDim,
              font: `11px ${palette.mono}`,
            },
          }),
        );
      }

      if (!isDone) {
        const sentinel = el("div", { style: { height: "1px", width: "100%" } });
        mainEl.appendChild(sentinel);
        rowObserver.disconnect();
        rowObserver.observe(sentinel);
      }
    }

    function renderDetail(): void {
      detailEl.textContent = "";
      const doc =
        selectedRowId === null
          ? undefined
          : rows.find((row) => String(row._id) === selectedRowId);
      if (!doc) {
        detailEl.style.display = "none";
        return;
      }
      detailEl.style.display = "block";

      const actions: HTMLButtonElement[] = [];
      if (!editing) {
        actions.push(
          button(
            "Edit",
            () => {
              editing = true;
              editError = "";
              renderDetail();
            },
            "ghost",
          ),
        );
      }
      actions.push(
        button(
          "Close",
          () => {
            selectedRowId = null;
            editing = false;
            renderDetail();
            renderMain();
          },
          "ghost",
        ),
      );

      detailEl.appendChild(
        el(
          "div",
          {
            style: {
              display: "flex",
              gap: "8px",
              alignItems: "center",
              padding: "10px 12px",
              borderBottom: `1px solid ${palette.border}`,
            },
          },
          [
            text("Document", {
              color: palette.fgMuted,
              font: `11px ${palette.sans}`,
            }),
            text(String(doc._id), {
              font: `12px ${palette.mono}`,
              color: palette.fg,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }),
            el(
              "div",
              { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
              actions,
            ),
          ],
        ),
      );

      const body = el("div", { style: { padding: "12px" } });
      if (!editing) {
        body.appendChild(jsonTree(doc, { expandDepth: 2 }));
      } else {
        const editable: Record<string, unknown> = { ...doc };
        delete editable._id;
        delete editable._creationTime;
        const area = textarea({
          value: JSON.stringify(editable, null, 2),
          rows: 12,
        });
        body.appendChild(area);
        body.appendChild(
          el("div", {
            text: editError,
            style: {
              color: palette.error,
              font: `11px ${palette.mono}`,
              margin: "6px 0",
              whiteSpace: "pre-wrap",
            },
          }),
        );
        body.appendChild(
          el(
            "div",
            { style: { display: "flex", gap: "6px", marginTop: "8px" } },
            [
              button("Save", () => {
                void save(String(doc._id), area.value);
              }),
              button(
                "Cancel",
                () => {
                  editing = false;
                  editError = "";
                  renderDetail();
                },
                "ghost",
              ),
            ],
          ),
        );
      }
      detailEl.appendChild(body);
    }

    async function save(id: string, raw: string): Promise<void> {
      if (selected === null) return;
      let fields: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          editError = "Fields must be a JSON object.";
          renderDetail();
          return;
        }
        fields = parsed as Record<string, unknown>;
      } catch (error) {
        editError = `Invalid JSON: ${errorMessage(error)}`;
        renderDetail();
        return;
      }
      try {
        await source.patchDocument(selected, id, fields);
        editing = false;
        editError = "";
        await loadRows(true);
      } catch (error) {
        editError = errorMessage(error);
        renderDetail();
      }
    }

    async function loadRows(reset: boolean): Promise<void> {
      if (selected === null) return;
      if (reset) {
        rows = [];
        cursor = null;
        isDone = true;
        selectedRowId = null;
      }
      loading = true;
      renderMain();
      try {
        const result = await source.listTableRows(selected, {
          cursor,
          limit: PAGE_SIZE,
        });
        rows = reset ? result.rows : rows.concat(result.rows);
        cursor = result.cursor;
        isDone = result.isDone;
      } catch {
        isDone = true;
      } finally {
        loading = false;
        renderMain();
        renderDetail();
      }
    }

    const unsubscribeData = source.subscribe("data", renderList);
    const unsubscribeSchema = source.subscribe("schema", renderMain);

    renderList();
    renderMain();

    return () => {
      rowObserver.disconnect();
      unsubscribeData();
      unsubscribeSchema();
      root.remove();
    };
  },
};
