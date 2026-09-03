/**
 * M20.1 §12.2 — LOCAL redaction, applied BEFORE any content reaches the
 * durable spool, upload, checksum input, or diagnostics. The server re-redacts
 * at ingestion (defense in depth) — this pass is the one that keeps a secret
 * from ever being durably written on the operator's machine.
 *
 * MIRROR of `src/server/credentials/redact.ts` (the runner sits outside the
 * app's dependency firewall; contracts are mirrored, not imported — keep the
 * pattern lists in lockstep). Adds the two client-only concerns the server
 * cannot know: configured secret ENV VALUES and home-directory prefixes.
 */

export const REDACTED = "‹redacted›";

// Mirrored from src/lib/redact.ts — keep in lockstep (pinned by the §12.13
// golden mirror corpus; tmb_ runner-bootstrap tokens are covered on every
// side — a security fix under the icebox's defect exception).
const SECRET_PATTERNS: RegExp[] = [
  /\btm[orb]?_[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Env names whose VALUES are scrubbed wherever they appear (PRD §12.2). */
const SECRET_ENV_NAMES = [
  "STACKS_TOKEN",
  "STACKS_BOOTSTRAP_TOKEN",
  "STACKS_WEBHOOK_SECRET",
  "STACKS_WORKLOAD_SVID",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "R2_SECRET_ACCESS_KEY",
];

export interface SessionRedactor {
  text(input: string): string;
  value(input: unknown): unknown;
}

/**
 * Build a redactor bound to the current process env + home directory. The
 * literal set is resolved ONCE so every spool write pays only string work.
 * Home-directory prefixes are scrubbed to `~` where the absolute path is not
 * evidence (PRD §12.2) — repository identity is the normalized owner/name.
 */
export function createSessionRedactor(
  opts: {
    env?: Record<string, string | undefined>;
    homedir?: string | null;
    literals?: string[];
  } = {},
): SessionRedactor {
  const env = opts.env ?? process.env;
  const literals = [
    ...(opts.literals ?? []),
    ...SECRET_ENV_NAMES.map((name) => env[name]).filter(
      (v): v is string => typeof v === "string" && v.length >= 6,
    ),
  ];
  const home = opts.homedir?.replace(/\/$/, "");

  function text(input: string): string {
    let out = input;
    for (const literal of literals) {
      out = out.split(literal).join(REDACTED);
    }
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, REDACTED);
    }
    if (home && home.length > 1) {
      out = out.split(home).join("~");
    }
    return out;
  }

  function value(input: unknown): unknown {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = value(v);
      }
      return out;
    }
    return input;
  }

  return { text, value };
}
