import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderResult, stableStringify } from "../src/render";

// Fixtures lifted from the app repo's frozen result-shape snapshots
// (tests/mcp/__snapshots__/result-shape.test.ts.snap) at authoring time.
// listTasks and createTask are verbatim; acquireLease is a shape-faithful
// subset (fields trimmed — only the nested-object structure matters here).

/** list_tasks — the canonical `{ <plural>: [...] }` list shape + metadata. */
const listTasks = {
  boardId: "board_1",
  boardKind: "TASKS",
  boardName: "Sprint 12",
  nextCursor: null,
  tasks: [
    {
      archivedAt: null,
      columnId: "col_1",
      columnName: "In progress",
      dueAt: "2026-06-20T00:00:00.000Z",
      id: "task_1",
      key: "STK-7",
      number: 7,
      priority: "HIGH",
      title: "Fix login redirect",
    },
    {
      archivedAt: null,
      columnId: "col_2",
      columnName: "Todo",
      dueAt: null,
      id: "task_2",
      key: "STK-8",
      number: 8,
      priority: "MEDIUM",
      title: "Polish empty states",
    },
  ],
  totalCount: 2,
};

/** create_task — small flat object (write-tool shape). */
const createTask = { id: "task_9", key: "STK-42", number: 42 };

/** acquire_lease — single nested object, NOT a list shape. */
const acquireLease = {
  lease: {
    acquiredAt: "2026-06-21T00:00:00.000Z",
    boardId: "board_1",
    conflictPolicy: "BLOCK",
    holderAgentId: "agent_1",
    id: "lease_1",
    mode: "EXCLUSIVE",
    status: "ACTIVE",
    targetLabel: "STK-1",
    workspaceId: "ws_1",
  },
};

describe("renderResult --json", () => {
  it("is a byte-stable stringify of createTask (exact bytes)", () => {
    const expected =
      '{\n  "id": "task_9",\n  "key": "STK-42",\n  "number": 42\n}';
    assert.equal(renderResult(createTask, { json: true }), expected);
  });

  it("is independent of key insertion order (byte-stable)", () => {
    const shuffled = { number: 42, key: "STK-42", id: "task_9" };
    assert.equal(
      renderResult(shuffled, { json: true }),
      renderResult(createTask, { json: true }),
    );
    // Nested objects and arrays too.
    const shuffledList = {
      totalCount: 2,
      tasks: [...listTasks.tasks].map(({ title, ...rest }) => ({
        title,
        ...rest,
      })),
      nextCursor: null,
      boardName: "Sprint 12",
      boardKind: "TASKS",
      boardId: "board_1",
    };
    assert.equal(
      renderResult(shuffledList, { json: true }),
      renderResult(listTasks, { json: true }),
    );
  });

  it("round-trips to the same data", () => {
    assert.deepEqual(
      JSON.parse(renderResult(listTasks, { json: true })),
      listTasks,
    );
  });

  it("handles non-object roots", () => {
    assert.equal(renderResult(null, { json: true }), "null");
    assert.equal(renderResult([1, 2], { json: true }), "[\n  1,\n  2\n]");
  });
});

describe("renderResult human mode — list shapes", () => {
  it("renders a compact table for { tasks: [...] } with metadata lines", () => {
    const out = renderResult(listTasks, { json: false });
    const lines = out.split("\n");
    // Header row: columns in first-seen order.
    assert.match(
      lines[0],
      /archivedAt\s+columnId\s+columnName\s+dueAt\s+id\s+key\s+number\s+priority\s+title/,
    );
    // One line per row, cells present.
    assert.match(out, /STK-7/);
    assert.match(out, /Fix login redirect/);
    assert.match(out, /STK-8/);
    assert.match(out, /Polish empty states/);
    // Scalar siblings render as metadata lines.
    assert.match(out, /boardName: Sprint 12/);
    assert.match(out, /totalCount: 2/);
    // Header + 2 rows + 5 metadata lines.
    assert.equal(lines.length, 8);
  });

  it("renders empty lists as (none), keeping metadata", () => {
    const out = renderResult({ boards: [], totalCount: 0 }, { json: false });
    assert.match(out, /boards: \(none\)/);
    assert.match(out, /totalCount: 0/);
  });
});

describe("renderResult human mode — JSON fallback for unknown shapes", () => {
  it("falls back for single nested objects (acquire_lease)", () => {
    assert.equal(
      renderResult(acquireLease, { json: false }),
      stableStringify(acquireLease),
    );
  });

  it("falls back for flat objects (create_task)", () => {
    assert.equal(
      renderResult(createTask, { json: false }),
      stableStringify(createTask),
    );
  });

  it("falls back when there are multiple array properties", () => {
    const two = { as: [{ a: 1 }], bs: [{ b: 2 }] };
    assert.equal(renderResult(two, { json: false }), stableStringify(two));
  });

  it("falls back when the array holds non-objects", () => {
    const scalars = { ids: ["a", "b"] };
    assert.equal(
      renderResult(scalars, { json: false }),
      stableStringify(scalars),
    );
  });

  it("falls back when a sibling is a nested object (not a scalar)", () => {
    const nested = { tasks: [{ id: "t1" }], board: { id: "b1" } };
    assert.equal(
      renderResult(nested, { json: false }),
      stableStringify(nested),
    );
  });
});

// ---------------------------------------------------------------------------
// JEN-495 (D4/AC2.2) — search_tasks renders ONE LINE PER HIT.
//
// The generic table gives search_tasks thirteen columns and ~200 characters a
// row, so every hit wrapped across several terminal lines; an agent cut the
// page with `head -30` and never reached the card that held its prior context
// (§4 G5). The server's ORDER is kept exactly — a client that re-sorts a page
// disagrees with the query that produced it.
// ---------------------------------------------------------------------------

describe("renderResult — search_tasks (JEN-495 D4)", () => {
  it("search_tasks: one line per hit, total, and the continuation cursor", () => {
    const out = renderResult(
      {
        results: [
          {
            id: "t1",
            key: "JEN-257",
            title: "Export/import v1",
            boardName: "Client runtime",
            columnName: "Done",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
          {
            id: "t2",
            key: "JEN-9",
            title: "Second",
            boardName: "B",
            columnName: "C",
            updatedAt: "2026-02-01T00:00:00.000Z",
          },
        ],
        totalCount: 35,
        nextCursor: "cur_abc",
        notice: "Showing 2 of 35 matches",
      },
      { json: false, tool: "search_tasks" },
    );
    assert.deepEqual(out.split("\n"), [
      "JEN-257  Export/import v1  · Client runtime · Done · 2026-03-01T00:00:00.000Z",
      "JEN-9    Second  · B · C · 2026-02-01T00:00:00.000Z",
      "total: 35",
      "next: --cursor cur_abc",
      "Showing 2 of 35 matches",
    ]);
  });

  it("search_tasks: an empty page says so; no cursor line without one", () => {
    const out = renderResult(
      { results: [], totalCount: 0, nextCursor: null },
      { json: false, tool: "search_tasks" },
    );
    assert.deepEqual(out.split("\n"), ["no matching tasks", "total: 0"]);
  });

  it("search_tasks: --json is untouched, and another tool keeps the table", () => {
    const payload = { results: [{ id: "t1", key: "K-1" }], totalCount: 1 };
    assert.equal(
      renderResult(payload, { json: true, tool: "search_tasks" }),
      stableStringify(payload),
    );
    assert.match(
      renderResult(payload, { json: false, tool: "list_tasks" }),
      /^id\s+key/,
    );
  });
});
