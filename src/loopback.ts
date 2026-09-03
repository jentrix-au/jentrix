/**
 * The real loopback HTTP listener + browser opener for `jentrix login` (C4.2).
 *
 * Split out of `main.ts` so the port-selection + binding behaviour is directly
 * unit-testable against REAL sockets (the stage requires an "occupy 8976
 * in-test" fallback test) without importing the process edge. Imports ONLY
 * `node:` builtins + the sibling `oauth` constants, so it stays firewall-safe.
 *
 * Security: binds `127.0.0.1` ONLY (never `0.0.0.0`), so no off-box client can
 * reach the authorization code. The callback response NEVER echoes the code —
 * it renders a plain human page and hands the code to the caller in-process.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import { CALLBACK_PATH, LOOPBACK_HOST } from "./oauth";
import { browserTarget } from "./exec-target";

/** A loopback callback result: the code + the state the AS echoed back. */
export interface CallbackResult {
  code: string;
  state: string | null;
}

/** A bound loopback listener awaiting the OAuth redirect. */
export interface LoopbackListener {
  /** The port that was actually claimed (first free of the requested list). */
  port: number;
  /** Resolves on the first `/callback` hit; rejects on timeout / error param. */
  waitForCode(): Promise<CallbackResult>;
  /** Tear the socket down (idempotent-safe to call in a finally). */
  close(): Promise<void>;
}

/** Default inactivity timeout for the callback wait (5 minutes). */
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

/**
 * Try to bind ONE loopback port. Resolves with a `LoopbackListener` on success,
 * or `null` when the port is busy / unbindable (EADDRINUSE etc.). Binds
 * `127.0.0.1` explicitly.
 */
export function tryBindPort(
  port: number,
  timeoutMs = CALLBACK_TIMEOUT_MS,
): Promise<LoopbackListener | null> {
  return new Promise((resolve) => {
    let settleCode: ((r: CallbackResult) => void) | null = null;
    let rejectCode: ((e: Error) => void) | null = null;
    let timer: NodeJS.Timeout | null = null;

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      // Human-facing page only — NEVER echo the authorization code.
      res.writeHead(error || !code ? 400 : 200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Jentrix CLI</title>` +
          `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
          (error || !code
            ? `<h1>Sign-in failed</h1><p>${error ? escapeHtml(error) : "no authorization code was returned"}. ` +
              `Close this tab and re-run <code>jentrix login</code>.</p>`
            : `<h1>Signed in</h1><p>You can close this tab and return to your terminal.</p>`) +
          `</body>`,
      );
      if (timer) clearTimeout(timer);
      if (error) rejectCode?.(new Error(`authorization failed: ${error}`));
      else if (!code)
        rejectCode?.(new Error("callback had no authorization code"));
      else settleCode?.({ code, state: url.searchParams.get("state") });
    });

    server.once("error", () => resolve(null));
    server.listen(port, LOOPBACK_HOST, () => {
      resolve({
        port,
        waitForCode: () =>
          new Promise<CallbackResult>((res, rej) => {
            settleCode = res;
            rejectCode = rej;
            timer = setTimeout(
              () => rej(new Error(`no callback within ${timeoutMs / 1000}s`)),
              timeoutMs,
            );
            timer.unref?.();
          }),
        close: () =>
          new Promise<void>((resolveClose) => {
            if (timer) clearTimeout(timer);
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/**
 * Bind the FIRST free port of `ports` (in order). Returns the listener, or
 * `null` when every port is busy (→ the CLI falls back to manual paste).
 */
export async function bindLoopback(
  ports: readonly number[],
  timeoutMs = CALLBACK_TIMEOUT_MS,
): Promise<LoopbackListener | null> {
  for (const port of ports) {
    const bound = await tryBindPort(port, timeoutMs);
    if (bound) return bound;
  }
  return null;
}

/** Best-effort browser open — the URL is always printed, so failure is fine. */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    // Windows quoting lives in `browserTarget`: an unquoted URL loses every
    // query parameter after the first `&` to cmd's command separator.
    const { file, args, options } = browserTarget(url, platform());
    try {
      const child = spawn(file, args, {
        stdio: "ignore",
        detached: true,
        ...options,
      });
      child.on("error", () => resolve());
      child.unref();
    } catch {
      /* ignore — printed URL is the fallback */
    }
    resolve();
  });
}
