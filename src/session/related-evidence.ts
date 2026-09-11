/**
 * Related evidence (semantic recall, @jentrix/cli 0.10.0 — PRD D9/D13): what
 * other work in the workspace already said about the aligned task. The server
 * returns it on `align_agent_session` as `relatedArtifacts` (the
 * `find_related_artifacts` by-task read: eligible kinds minus the session
 * inputs, the task's own and linked artifacts excluded, at most five above
 * the measured floor) with `relatedArtifactsNotice` when it is empty for a
 * reason; `jentrix task context` reads the same tool by task.
 *
 * ONE renderer for both commands, so the block reads the same at align and in
 * context. Pure: rows in, printable lines out.
 */

export interface RelatedArtifactHit {
  id: string;
  title: string;
  type: string;
  createdAt: string;
  taskId: string | null;
  taskKey: string | null;
  sessionId: string | null;
  /** Cosine similarity of the best chunk, in [0, 1]. */
  similarity: number;
  /** The opening of the best chunk, or null past the stored excerpt. */
  snippet: string | null;
  truncated: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The hits a server result carries, or null when the field is ABSENT — an
 * older server (contract < 1.4.0) never sends it, and D13 says print nothing
 * then rather than "none", which would claim a read that never happened.
 */
export function relatedArtifactsOf(
  value: unknown,
): RelatedArtifactHit[] | null {
  const list = (value as Record<string, unknown> | null)?.relatedArtifacts;
  if (!Array.isArray(list)) return null;
  return list
    .filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    )
    .map((row) => ({
      id: str(row.id),
      title: str(row.title),
      type: str(row.type),
      createdAt: str(row.createdAt),
      taskId: typeof row.taskId === "string" ? row.taskId : null,
      taskKey: typeof row.taskKey === "string" ? row.taskKey : null,
      sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
      similarity: typeof row.similarity === "number" ? row.similarity : 0,
      snippet: typeof row.snippet === "string" ? row.snippet : null,
      truncated: row.truncated === true,
    }));
}

/** The notice beside an empty block, or undefined. */
export function relatedNoticeOf(value: unknown): string | undefined {
  const notice = (value as Record<string, unknown> | null)
    ?.relatedArtifactsNotice;
  return typeof notice === "string" && notice.trim() ? notice : undefined;
}

/** One line of snippet, whitespace folded, bounded for a terminal. */
function snippetLine(snippet: string | null): string | null {
  if (!snippet) return null;
  const folded = snippet.replace(/\s+/g, " ").trim();
  if (!folded) return null;
  return folded.length > 160 ? `${folded.slice(0, 159).trimEnd()}…` : folded;
}

/**
 * Render the block. `null` hits → no lines (the field was absent: an older
 * server). Empty hits → one line, with the server's reason when it gave one,
 * so a fresh or unembedded card reads as "none — no embedding yet" rather
 * than as silence. Otherwise a header, then one row per artifact — kind, id,
 * title, similarity, the card it sits on — and its snippet indented beneath,
 * so an agent can decide whether to `artifact get` it before reading code.
 */
export function renderRelatedEvidence(
  hits: RelatedArtifactHit[] | null,
  notice?: string,
): string[] {
  if (hits === null) return [];
  if (hits.length === 0) {
    return [
      notice ? `Related evidence: none — ${notice}` : "Related evidence: none",
    ];
  }
  const lines = [`Related evidence (${hits.length}):`];
  for (const hit of hits) {
    const where = hit.taskKey ? `  ·  on ${hit.taskKey}` : "";
    const cut = hit.truncated ? "  ·  (tail not embedded)" : "";
    lines.push(
      `  ${hit.type.padEnd(14)} ${hit.id}  ${hit.title}  ·  ${Math.round(hit.similarity * 100)}%${where}${cut}`.trimEnd(),
    );
    const snippet = snippetLine(hit.snippet);
    if (snippet) lines.push(`    ${snippet}`);
  }
  if (notice) lines.push(`  (${notice})`);
  return lines;
}
