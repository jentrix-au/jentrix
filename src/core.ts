/**
 * The CLI CORE as a package entry — `@jentrix/cli/core` (open-client S2,
 * PRD §5.5 row 4).
 *
 * The application repository drives this core against its live MCP surface
 * (tests/cli/contract.test.ts: real `safe()`, real scope checks, real error
 * envelopes) and reaches it ONLY through the package boundary — this entry,
 * built to `dist/core.js` with `dist/core.d.ts` beside it — never by a
 * relative path into `src/`. Only the dependency-firewalled modules are
 * re-exported (cli/test/firewall.test.ts: `@modelcontextprotocol/sdk` types,
 * `node:` builtins and each other; no commander, no zod), so a consumer needs
 * no CLI-shell dependency to hold it.
 */
export { callTool } from "./call";
export type { CallOptions, CallOutcome, ToolCaller } from "./call";
export {
  EXIT_CODES,
  envelopeOfResult,
  envelopeToExit,
  parseErrorEnvelope,
} from "./errors";
export type { ExitDecision, McpErrorCode, McpErrorEnvelope } from "./errors";
export { renderResult, stableStringify } from "./render";
export type { RenderOptions } from "./render";
export { withRateLimitRetry } from "./retry";
export type { RetryOptions } from "./retry";
export { loadSurface, SurfaceError, TOOL_CLASSES } from "./surface";
export type {
  SurfaceAnnotations,
  SurfaceManifest,
  SurfaceTool,
  ToolClass,
} from "./surface";
