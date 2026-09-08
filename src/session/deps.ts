/** Session deps. */
import { type SessionToolCaller } from "../tool-client";
import { type GitRunner } from "../repo";
import type { PluginInvocation, PluginPathProbe } from "../commands/plugin";

/** What the client checks need — the installer's own resolvers, injected. */
export interface ClientProbeDeps extends PluginPathProbe {
  cliPackageRoot(): string;
  resolvePluginDir(): string | null;
  resolveCodexPluginDir(): string | null;
  resolveClaude(): Promise<string | null>;
  resolveCodex(): Promise<string | null>;
  invoke(file: string, args: string[]): Promise<PluginInvocation>;
  homeDir(): string;
}

export interface SessionCommandDeps {
  env: Record<string, string | undefined>;
  cwd(): string;
  configPath: string;
  /**
   * Resolve {token, url} or throw ConfigError (exit 7 when no token).
   * `tokenSource` says where the token came from — the host's config-following
   * bearer must engage ONLY for a config-file token (see hostConfigPathOf).
   */
  resolveTarget(): {
    token: string;
    url: string;
    tokenSource?: "flag" | "env" | "file";
  };
  ensureInstallationId(): string;
  connect(target: {
    token: string;
    url: string;
    /**
     * STA-26 — the VALIDATED session correlation (from the alignment marker
     * or an explicit --session, never model-authored). When present the
     * transport sends `X-Stacks-Session-Id`, the server validates it in
     * `safe()` (a bearer cannot stamp someone else's session), and every
     * activity payload the call writes carries `sessionId` — which is what
     * lets a minted issue's TASK_CREATED land in the session's RUN_SUMMARY.
     */
    sessionId?: string;
  }): Promise<{ caller: SessionToolCaller; close(): Promise<void> }>;
  git?: GitRunner;
  writeOut(text: string): void;
  writeErr(text: string): void;
  isInteractive: boolean;
  readLine(prompt: string): Promise<string>;
  /**
   * Absolute path of the BUNDLED session-host entry (dist/session-host-main.js
   * — client-runtime v2 D10: the host ships inside this package; nothing to
   * install). Null only when the build is missing (a source checkout that
   * never ran `pnpm build`).
   */
  resolveSessionHost(): string | null;
  /**
   * Foreground `jentrix-session-host run --plan-file <path>` (stdio
   * inherit). `env` is merged into the child's environment — the D18 channel
   * for a non-config credential (the plan file itself never carries one).
   */
  runSessionHost(
    hostPath: string,
    planPath: string,
    env?: Record<string, string>,
  ): Promise<number>;
  /**
   * Detached `jentrix-session-host run --plan-file <path>` with stdio to a
   * log file — background capture for attach without --watch (F-4/AGE-930).
   * Returns the child pid. `env` as above (D18).
   */
  spawnSessionHostDetached(
    hostPath: string,
    planPath: string,
    logPath: string,
    env?: Record<string, string>,
  ): number;
  spoolRoot: string;
  /** Injectable fetch for the REST boundaries (attested pushes); default global. */
  fetchImpl?: typeof fetch;
  /** Injectable pid-liveness probe (default: signal-0). */
  isPidAlive?(pid: number): boolean;
  /** Injectable delay for host-exit polling (default: setTimeout). */
  sleep?(ms: number): Promise<void>;
  /**
   * Open-client S5: the client-side probes the doctor reports through —
   * versions and install source, marketplace ownership, hook pinning, the
   * adopted contract. The installer's own resolvers, wired by main.ts; absent
   * in tests that do not exercise them.
   */
  client?: ClientProbeDeps;
}

export interface SessionStartFlags {
  project?: string;
  resume?: string;
  json?: boolean;
}

export interface SessionAttachFlags extends SessionStartFlags {
  provider?: "claude" | "codex";
  providerSession?: string;
  transcriptPath?: string;
  importHistory?: boolean;
  watch?: boolean;
  /**
   * JEN-457 — the per-session capture override, at the only moment it can be
   * made. A host's collection is immutable once it starts, so `align --capture`
   * over a live host started without capture is REFUSED; connect is where the
   * decision belongs. Absent = the server resolves it (account default, then
   * the built-in off).
   */
  capture?: boolean;
  skeleton?: boolean;
}

export interface SessionDoctorFlags {
  project?: string;
  json?: boolean;
  /** `--bundle [file]`: write the redacted support bundle (true = default name). */
  bundle?: string | boolean;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  fix?: string;
  /** Structured facts behind the detail (the contract check carries both sides). */
  data?: Record<string, unknown>;
}

export interface SessionAlignFlags {
  task?: string;
  sessionLevel?: boolean;
  owner?: string;
  agent?: string;
  agentEmoji?: string;
  capture?: boolean;
  skeleton?: boolean;
  budget?: number | false;
  provider?: "claude" | "codex";
  providerSession?: string;
  transcriptPath?: string;
  json?: boolean;
}
