/** Type surface of the OpenCode plugin (plain ESM; these declarations are for the CLI's tests and TypeScript consumers). */
export const PROVIDER: "opencode";
export interface PluginIdentity {
  package: string;
  version: string | null;
  behaviorRevision: string | null;
  resourceDigest: string | null;
  dir: string;
}
export function pluginIdentity(packageDir?: string): PluginIdentity;
export function ledgerDir(env?: Record<string, string | undefined>): string;
export type LedgerWriter = (event: string, payload: Record<string, unknown>) => void;
export function createLedgerWriter(options?: {
  dir?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}): LedgerWriter;
export function parseCommandFile(text: string): { description: string; template: string };
export function loadCommands(dir?: string): Record<string, { description: string; template: string }>;
export interface PluginOptions {
  write?: LedgerWriter;
  now?: () => number;
  commands?: Record<string, { description: string; template: string }>;
  commandsDir?: string;
  identity?: PluginIdentity;
  spawnSnapshot?: (event: string, payload: Record<string, unknown>, cwd: string) => void;
  dir?: string;
  env?: Record<string, string | undefined>;
}
export type PluginHooks = Record<string, (...args: any[]) => Promise<void>>;
export type Plugin = (input: {
  directory?: string;
  worktree?: string;
  project?: { id?: string };
  client?: unknown;
  serverUrl?: unknown;
}) => Promise<PluginHooks>;
export function createJentrixPlugin(options?: PluginOptions): Plugin;
export const JentrixOpenCodePlugin: Plugin;
