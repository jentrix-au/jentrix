/**
 * Curated command-tree data (stage C2.2). DATA ONLY — no logic lives here;
 * the tree builder in ./build.ts consumes these tables, and
 * test/aliases.test.ts keeps them honest against the real surface.json, so a
 * renamed or removed server tool fails CI in this package instead of
 * silently dropping a command.
 */

/**
 * Tool name → "noun verb" command path (exactly two space-separated
 * kebab-case segments). Tools NOT listed here still auto-mount under a group
 * derived from their name (see build.ts) — an alias buys ergonomics, never
 * reachability. Since client-runtime v2 Phase D the manifest is the PRODUCT
 * catalog (D8), so every key here must name a product tool.
 */
export const ALIASES: Record<string, string> = {
  // Jentrix MVP — the raw align tool mounts beside its session siblings
  // (agent attach-session, agent create-session, …); the hand-registered
  // `jentrix align` wizard keeps the reserved top-level name.
  align_agent_session: "agent align-session",
  // task
  archive_task: "task archive",
  create_task: "task create",
  get_task: "task get",
  list_tasks: "task list",
  move_task: "task move",
  search_tasks: "task search",
  update_task: "task update",
  // board
  create_board: "board create",
  get_board_snapshot: "board snapshot",
  list_boards: "board list",
  rename_board: "board rename",
  unarchive_boards: "board unarchive",
  // column / label
  list_columns: "column list",
  manage_columns: "column manage",
  list_labels: "label list",
  manage_labels: "label manage",
  // comment
  create_comment: "comment create",
  delete_comment: "comment delete",
  list_comments: "comment list",
  update_comment: "comment update",
  // subtask
  create_subtask: "subtask create",
  delete_subtask: "subtask delete",
  toggle_subtask: "subtask toggle",
  // member / workspace / activity
  list_members: "member list",
  list_workspaces: "workspace list",
  list_activity: "activity list",
  // task links (the universal task-link graph)
  add_task_link: "link add",
  list_task_links: "link list",
  remove_task_link: "link remove",
};

/**
 * Per-tool flag renames: tool name → { schema property → flag name }.
 * Used where a schema property's derived flag would collide with a
 * cross-cutting flag mounted on every generated command (`--url` is the
 * endpoint override, so a tool's own `url` property needs a distinct name).
 * A rename re-labels the property's value flag and its paired `--clear-*`
 * (nullable properties); JSON-mode groups keep their derived names (build.ts
 * warns), and test/build.test.ts asserts zero warnings over the real
 * surface.
 */
export const FLAG_RENAMES: Record<string, Record<string, string>> = {
  attach_artifact: { url: "artifact-url" },
};
