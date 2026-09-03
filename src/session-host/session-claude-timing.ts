/**
 * Jentrix MVP Control Room — 04-2 timing (control-room PRD AC3.6/AC3.7).
 *
 * `providerActiveDurationMs` and `toolDurationMs` are null on every session
 * row ever written, and the reason is locatable rather than mysterious:
 * `aggregateSessionUsage` returns null for an EMPTY interval list
 * (session-usage.ts), and the only caller of the bridge's interval marks is
 * the CODEX interactive host. The Claude transcript-tailing path — the only
 * one the MVP actually uses — never marked an interval, so both columns were
 * structurally null.
 *
 * The gap report offered "populate or drop the columns". Dropping was refused
 * on evidence (17 files read them, and the schema is shared with the parent
 * deployment), so this module populates them. It is the pairing half only: the
 * aggregator already knew how to sum intervals.
 *
 * Both figures are MEASURED from timestamps the transcript already carries,
 * never derived by subtraction:
 *
 *   • toolDurationMs      — each `tool_use` block paired with the
 *                           `tool_result` that answers it.
 *   • providerActiveDurationMs — each assistant entry paired with whatever
 *                           handed it control: the user message that prompted
 *                           it, or the tool result that unblocked it.
 *
 * "Turn duration minus tool time" would have been the easy definition and a
 * dishonest one — it goes negative under parallel tools and reports queueing
 * as generation. Measuring each generation segment where it actually begins
 * costs one more piece of state and answers the question that was asked.
 *
 * PURE and DETERMINISTIC: no I/O, no clock. The wall-clock timestamps in the
 * transcript ARE the right clock here — this is a replay of recorded events,
 * not a live measurement, and the aggregator clamps each pair at zero.
 */

export type ObservedIntervalKind = "turn" | "tool";

export interface ObservedInterval {
  kind: ObservedIntervalKind;
  /** Stable per-interval id — the aggregator dedupes and names gaps by it. */
  id: string;
  startedAt: number;
  endedAt: number;
}

/** What one mapped transcript line contributes to timing. */
export interface TimingLine {
  /** Epoch ms parsed from the entry's own timestamp. */
  at: number;
  role: "user" | "assistant";
  /** `tool_use` block ids this assistant entry opened. */
  toolStarts?: readonly string[];
  /** `tool_use_id`s this user entry answered. */
  toolEnds?: readonly string[];
  /** The entry's uuid — used to name the generation segment. */
  id: string;
}

/**
 * Pairs transcript lines into closed intervals as they stream past.
 *
 * Stateful by necessity (pairing is cross-line) but I/O-free and clock-free,
 * so the whole rule is unit-testable from a list of lines.
 */
export class ClaudeTimingTracker {
  /**
   * When the provider was last handed control: the newest user message or
   * tool result. Null before the first one — an assistant entry with no
   * preceding boundary (a resumed transcript whose head we never saw) yields
   * NO interval rather than an invented one starting at zero.
   */
  private boundaryAt: number | null = null;
  private readonly openTools = new Map<string, number>();

  /** Feed one line; returns every interval this line CLOSED. */
  observe(line: TimingLine): ObservedInterval[] {
    const closed: ObservedInterval[] = [];

    for (const toolUseId of line.toolEnds ?? []) {
      const startedAt = this.openTools.get(toolUseId);
      if (startedAt === undefined) continue; // opened before we were watching
      this.openTools.delete(toolUseId);
      closed.push({
        kind: "tool",
        id: `tool:${toolUseId}`,
        startedAt,
        endedAt: line.at,
      });
    }

    if (line.role === "assistant") {
      if (this.boundaryAt !== null) {
        closed.push({
          kind: "turn",
          id: `turn:${line.id}`,
          startedAt: this.boundaryAt,
          endedAt: line.at,
        });
      }
      for (const toolUseId of line.toolStarts ?? []) {
        this.openTools.set(toolUseId, line.at);
      }
      // An assistant entry that called tools does NOT hand control back to the
      // provider — the tools run next, and their results are the boundary that
      // does. Without this, the wait for a tool would be billed as generation.
      this.boundaryAt = (line.toolStarts?.length ?? 0) > 0 ? null : line.at;
      return closed;
    }

    // A user entry always hands control to the provider: a typed message, or
    // a tool result that unblocks the turn already in flight.
    this.boundaryAt = line.at;
    return closed;
  }

  /**
   * Tool calls still open at close — a killed host, a tool that never
   * returned. Reported so the aggregator can NAME the gap and degrade
   * coverage to PARTIAL rather than quietly summing a shorter total.
   */
  unclosedToolIds(): string[] {
    return [...this.openTools.keys()].map((id) => `tool:${id}`);
  }
}
