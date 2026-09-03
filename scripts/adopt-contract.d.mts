export const PACKAGE_ROOT: string;
export const SURFACE_NOTICE: string;
export const BUNDLE_NOTICE: string;
export function serialize(value: unknown): string;
export function digestOf(bytes: Uint8Array | string): string;
export function loadContract(
  source: string,
  fetchImpl?: typeof fetch,
): Promise<{
  bytes: Uint8Array;
  bundle: Record<string, unknown> & { tools: unknown[]; vectors: unknown };
  digest: string;
  from: string;
  publicationState: string | null;
}>;
export function projections(
  bundle: Record<string, unknown>,
  digest: string,
): Record<string, string>;
export function writeProjections(
  outDir: string,
  files: Record<string, string>,
): void;
