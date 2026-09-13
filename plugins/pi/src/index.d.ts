/** Type surface of the Pi extension (plain ESM; these declarations are for the CLI's tests and TypeScript consumers). */
export const PROVIDER: "pi";
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
export function expandTemplate(template: string, args: string | undefined): string;
export interface ExtensionOptions {
  write?: LedgerWriter;
  now?: () => number;
  commands?: Record<string, { description: string; template: string }>;
  commandsDir?: string;
  identity?: PluginIdentity;
  spawnSnapshot?: (event: string, payload: Record<string, unknown>, cwd: string) => void;
  dir?: string;
  env?: Record<string, string | undefined>;
}
export interface ExtensionApi {
  on(event: string, handler: (event: any, ctx: any) => Promise<void> | void): void;
  registerCommand(
    name: string,
    definition: { description: string; handler: (args: string, ctx: any) => Promise<void> },
  ): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
}
export function createJentrixExtension(options?: ExtensionOptions): (pi: ExtensionApi) => void;
declare const extension: (pi: ExtensionApi) => void;
export default extension;
