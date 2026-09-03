/**
 * M20.1 §12.5 — the PURE session usage/timing aggregator. Provider-reported
 * receipts only; NOTHING is ever estimated from characters, bytes, price
 * tables, or another tokenizer (AC35). Durations come from paired monotonic
 * lifecycle events; wall time is the SERVER's (never computed here).
 *
 * Coverage semantics (rule 9):
 *   COMPLETE    — every observable provider turn carried a usable receipt and
 *                 every measured interval closed;
 *   PARTIAL     — something is missing, and every gap is NAMED;
 *   UNAVAILABLE — the runtime exposed no usable receipts at all.
 */

export interface UsageReceipt {
  /** Provider event/turn identity — the dedupe key (rule 2/5, AC38). */
  eventId: string;
  /** The provider turn this receipt belongs to, when known. */
  turnId?: string | null;
  /**
   * "delta" — tokens for one turn; "cumulative" — the provider reports thread
   * totals, and only a continuous-capture delta between two acknowledged
   * cumulative receipts may contribute (rule 3, AC37/AC46).
   */
  kind: "delta" | "cumulative";
  inputTokens: number;
  outputTokens: number;
  /**
   * Disjoint subsets of inputTokens (AGE-938). Absent = this receipt did not
   * report the field (an old transcript format, or a provider without the
   * concept) — distinct from a reported 0.
   */
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  /**
   * Model-catalog PRD D7: the 1-hour-TTL SUBSET of cacheCreationTokens (the
   * remainder is the 5-minute tier). Absent = the receipt carried no TTL
   * split (an older Claude transcript; every Codex receipt) — distinct from a
   * reported 0, and priced at the 5-minute rate as a disclosed floor.
   */
  cacheCreation1hTokens?: number | null;
  /**
   * TPM Slice 2 (AC2.7): reasoning tokens as a SUBSET of outputTokens.
   * Absent = the receipt did not report them (Claude reports them as
   * `output_tokens_details.thinking_tokens`; older transcripts do not).
   */
  reasoningOutputTokens?: number | null;
  /**
   * TPM Slice 2 (AC2.4): the model that produced this receipt, as the
   * provider named it (Claude: message.model on the same transcript entry;
   * Codex: turn_context.model when the stream reports one). Absent = never
   * observed for this receipt — grouped under the null-model bucket.
   */
  modelId?: string | null;
  /** Monotonic ms when the receipt was observed. */
  at: number;
}

export interface LifecycleInterval {
  id: string;
  startedAt: number;
  /** Missing = the terminal event was never observed (rule 7). */
  endedAt?: number | null;
}

/** A continuous-capture window on the monotonic clock (rule 3). */
export interface ObservedRange {
  from: number;
  to: number;
}

/** TPM Slice 2 (AC2.4): the cumulative rollup for ONE model bucket. */
export interface PerModelUsage {
  /** Null = receipts whose model was never observed. */
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** The 1-hour subset of cacheCreationTokens; null = never reported. */
  cacheCreation1hTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface SessionUsageRollup {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null when NO receipt reported the field — never a fabricated 0. */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** D7: the 1-hour subset of cacheCreationTokens; null = never reported. */
  cacheCreation1hTokens: number | null;
  /** TPM Slice 2 (AC2.7): subset of outputTokens; null = never reported. */
  reasoningOutputTokens: number | null;
  providerActiveDurationMs: number | null;
  toolDurationMs: number | null;
  coverage: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  missingRanges: string[];
  /**
   * TPM Slice 2 (AC2.4): the same receipts GROUPED by the model that
   * produced them — the fact the pipeline used to throw away. Empty when no
   * receipt was usable. Sums here always equal the totals above: every
   * usable receipt lands in exactly one bucket (null model included).
   */
  perModel: PerModelUsage[];
}

function insideOneRange(
  ranges: ObservedRange[],
  from: number,
  to: number,
): boolean {
  return ranges.some((r) => r.from <= from && to <= r.to);
}

export function aggregateSessionUsage(input: {
  receipts: UsageReceipt[];
  /** Continuous capture windows; a cumulative delta must sit inside ONE. */
  observedRanges: ObservedRange[];
  providerTurns: LifecycleInterval[];
  toolIntervals: LifecycleInterval[];
  /**
   * JEN-294: gaps the CALLER already knows about — the restart baseline a
   * watch host seeded from the spool snapshot. They enter `missingRanges`
   * verbatim, which is what keeps coverage from reading COMPLETE across a
   * restart: the seam is named, never smoothed over.
   */
  namedGaps?: string[];
}): SessionUsageRollup {
  const missing: string[] = [...(input.namedGaps ?? [])];

  // Rule 2/5 (AC38): one receipt contributes at most once — dedupe by identity.
  const seen = new Set<string>();
  const receipts = input.receipts
    .filter((r) => {
      if (seen.has(r.eventId)) return false;
      seen.add(r.eventId);
      return true;
    })
    .sort((a, b) => a.at - b.at);

  let inputTokens = 0;
  let outputTokens = 0;
  let usable = 0;
  const receiptTurnIds = new Set<string>();

  // AGE-938: field-level reporting — a cache sum surfaces only when at least
  // one receipt actually carried the field, else it stays null.
  let cacheReadTokens = 0;
  let cacheReadReported = false;
  let cacheCreationTokens = 0;
  let cacheCreationReported = false;
  // D7: the 1-hour subset rides the same field-level honesty.
  let cacheCreation1hTokens = 0;
  let cacheCreation1hReported = false;
  // TPM Slice 2 (AC2.7): reasoning rides the same field-level honesty.
  let reasoningOutputTokens = 0;
  let reasoningReported = false;

  // TPM Slice 2 (AC2.4): the same contributions, grouped by producing model.
  // Every usable contribution lands in exactly one bucket (null = the model
  // was never observed for the receipt), so Σ buckets ≡ the totals above.
  interface Bucket {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheReadReported: boolean;
    cacheCreationTokens: number;
    cacheCreationReported: boolean;
    cacheCreation1hTokens: number;
    cacheCreation1hReported: boolean;
    reasoningOutputTokens: number;
    reasoningReported: boolean;
  }
  const buckets = new Map<string | null, Bucket>();
  interface Contribution {
    modelId: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    cacheCreation1hTokens?: number;
    reasoningOutputTokens?: number;
  }
  const contribute = (c: Contribution): void => {
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
    const bucket =
      buckets.get(c.modelId) ??
      ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheReadReported: false,
        cacheCreationTokens: 0,
        cacheCreationReported: false,
        cacheCreation1hTokens: 0,
        cacheCreation1hReported: false,
        reasoningOutputTokens: 0,
        reasoningReported: false,
      } satisfies Bucket);
    bucket.inputTokens += c.inputTokens;
    bucket.outputTokens += c.outputTokens;
    if (typeof c.cacheReadTokens === "number") {
      cacheReadTokens += c.cacheReadTokens;
      cacheReadReported = true;
      bucket.cacheReadTokens += c.cacheReadTokens;
      bucket.cacheReadReported = true;
    }
    if (typeof c.cacheCreationTokens === "number") {
      cacheCreationTokens += c.cacheCreationTokens;
      cacheCreationReported = true;
      bucket.cacheCreationTokens += c.cacheCreationTokens;
      bucket.cacheCreationReported = true;
    }
    if (typeof c.cacheCreation1hTokens === "number") {
      cacheCreation1hTokens += c.cacheCreation1hTokens;
      cacheCreation1hReported = true;
      bucket.cacheCreation1hTokens += c.cacheCreation1hTokens;
      bucket.cacheCreation1hReported = true;
    }
    if (typeof c.reasoningOutputTokens === "number") {
      reasoningOutputTokens += c.reasoningOutputTokens;
      reasoningReported = true;
      bucket.reasoningOutputTokens += c.reasoningOutputTokens;
      bucket.reasoningReported = true;
    }
    buckets.set(c.modelId, bucket);
    usable += 1;
  };
  const modelOf = (receipt: UsageReceipt): string | null =>
    receipt.modelId?.trim() || null;

  let cumulativeBaseline: UsageReceipt | null = null;
  for (const receipt of receipts) {
    if (receipt.turnId) receiptTurnIds.add(receipt.turnId);
    if (receipt.kind === "delta") {
      contribute({
        modelId: modelOf(receipt),
        inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens,
        ...(typeof receipt.cacheReadTokens === "number"
          ? { cacheReadTokens: receipt.cacheReadTokens }
          : {}),
        ...(typeof receipt.cacheCreationTokens === "number"
          ? { cacheCreationTokens: receipt.cacheCreationTokens }
          : {}),
        ...(typeof receipt.cacheCreation1hTokens === "number"
          ? { cacheCreation1hTokens: receipt.cacheCreation1hTokens }
          : {}),
        ...(typeof receipt.reasoningOutputTokens === "number"
          ? { reasoningOutputTokens: receipt.reasoningOutputTokens }
          : {}),
      });
      continue;
    }
    // Cumulative: a delta needs an acknowledged baseline AND continuous
    // capture across the whole interval between the two receipts (rule 3).
    if (cumulativeBaseline === null) {
      cumulativeBaseline = receipt;
      missing.push(
        `cumulative receipt ${receipt.eventId} established a baseline only — the thread total before it is not attributable to this session`,
      );
      continue;
    }
    if (
      !insideOneRange(input.observedRanges, cumulativeBaseline.at, receipt.at)
    ) {
      missing.push(
        `cumulative interval ${cumulativeBaseline.eventId}→${receipt.eventId} crossed an unobserved range and was not counted`,
      );
      cumulativeBaseline = receipt; // becomes the next baseline
      continue;
    }
    const dIn = receipt.inputTokens - cumulativeBaseline.inputTokens;
    const dOut = receipt.outputTokens - cumulativeBaseline.outputTokens;
    if (dIn < 0 || dOut < 0) {
      missing.push(
        `cumulative receipt ${receipt.eventId} regressed below its baseline and was not counted`,
      );
      cumulativeBaseline = receipt;
      continue;
    }
    // Cache/reasoning deltas count only when BOTH endpoints reported the
    // field and the delta is non-negative — a regressing counter on an
    // otherwise valid interval reads as unreported for that interval, never
    // as negative usage. The interval's spend belongs to the LATER receipt's
    // model — the model that was running when the total grew.
    contribute({
      modelId: modelOf(receipt),
      inputTokens: dIn,
      outputTokens: dOut,
      ...(typeof receipt.cacheReadTokens === "number" &&
      typeof cumulativeBaseline.cacheReadTokens === "number" &&
      receipt.cacheReadTokens >= cumulativeBaseline.cacheReadTokens
        ? {
            cacheReadTokens:
              receipt.cacheReadTokens - cumulativeBaseline.cacheReadTokens,
          }
        : {}),
      ...(typeof receipt.cacheCreationTokens === "number" &&
      typeof cumulativeBaseline.cacheCreationTokens === "number" &&
      receipt.cacheCreationTokens >= cumulativeBaseline.cacheCreationTokens
        ? {
            cacheCreationTokens:
              receipt.cacheCreationTokens -
              cumulativeBaseline.cacheCreationTokens,
          }
        : {}),
      ...(typeof receipt.cacheCreation1hTokens === "number" &&
      typeof cumulativeBaseline.cacheCreation1hTokens === "number" &&
      receipt.cacheCreation1hTokens >= cumulativeBaseline.cacheCreation1hTokens
        ? {
            cacheCreation1hTokens:
              receipt.cacheCreation1hTokens -
              cumulativeBaseline.cacheCreation1hTokens,
          }
        : {}),
      ...(typeof receipt.reasoningOutputTokens === "number" &&
      typeof cumulativeBaseline.reasoningOutputTokens === "number" &&
      receipt.reasoningOutputTokens >= cumulativeBaseline.reasoningOutputTokens
        ? {
            reasoningOutputTokens:
              receipt.reasoningOutputTokens -
              cumulativeBaseline.reasoningOutputTokens,
          }
        : {}),
    });
    cumulativeBaseline = receipt;
  }

  const perModel: PerModelUsage[] = [...buckets.entries()].map(
    ([modelId, bucket]) => ({
      modelId,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheReadTokens: bucket.cacheReadReported ? bucket.cacheReadTokens : null,
      cacheCreationTokens: bucket.cacheCreationReported
        ? bucket.cacheCreationTokens
        : null,
      cacheCreation1hTokens: bucket.cacheCreation1hReported
        ? bucket.cacheCreation1hTokens
        : null,
      reasoningOutputTokens: bucket.reasoningReported
        ? bucket.reasoningOutputTokens
        : null,
    }),
  );

  // Rule 7: paired monotonic intervals; unmatched terminals are NAMED.
  function sumIntervals(
    intervals: LifecycleInterval[],
    label: string,
  ): { total: number | null; complete: boolean } {
    let total = 0;
    let closed = 0;
    for (const interval of intervals) {
      if (interval.endedAt == null) {
        missing.push(
          `${label} interval ${interval.id} never observed its terminal event`,
        );
        continue;
      }
      total += Math.max(0, interval.endedAt - interval.startedAt);
      closed += 1;
    }
    if (intervals.length === 0) return { total: null, complete: true };
    return { total, complete: closed === intervals.length };
  }
  const provider = sumIntervals(input.providerTurns, "provider turn");
  const tool = sumIntervals(input.toolIntervals, "tool");

  // Rule 9: COMPLETE needs a usable receipt for every observable provider turn.
  const turnsWithoutReceipts = input.providerTurns.filter(
    (t) => !receiptTurnIds.has(t.id),
  );
  for (const turn of turnsWithoutReceipts) {
    missing.push(`provider turn ${turn.id} carried no usable usage receipt`);
  }

  if (usable === 0) {
    return {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      cacheCreation1hTokens: null,
      reasoningOutputTokens: null,
      providerActiveDurationMs: provider.total,
      toolDurationMs: tool.total,
      coverage: "UNAVAILABLE",
      missingRanges: missing,
      perModel: [],
    };
  }
  const complete = missing.length === 0 && provider.complete && tool.complete;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadReported ? cacheReadTokens : null,
    cacheCreationTokens: cacheCreationReported ? cacheCreationTokens : null,
    cacheCreation1hTokens: cacheCreation1hReported
      ? cacheCreation1hTokens
      : null,
    reasoningOutputTokens: reasoningReported ? reasoningOutputTokens : null,
    providerActiveDurationMs: provider.total,
    toolDurationMs: tool.total,
    coverage: complete ? "COMPLETE" : "PARTIAL",
    missingRanges: missing,
    perModel,
  };
}
