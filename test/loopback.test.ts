import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  bindLoopback,
  tryBindPort,
  type LoopbackListener,
} from "../src/loopback";
import { LOOPBACK_PORTS } from "../src/oauth";

/** Occupy a port with a real loopback server so bindLoopback must skip it. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("bindLoopback — port selection", () => {
  const [P1, P2, P3]: number[] = [...LOOPBACK_PORTS];
  let blocker: Server | null = null;

  before(async () => {
    // Occupy the FIRST registered port (8976) — the stage's exact scenario.
    // If it's somehow already taken on this host, occupy() rejects; tolerate
    // that by leaving blocker null (the fall-through assertion still holds).
    try {
      blocker = await occupy(P1);
    } catch {
      blocker = null;
    }
  });

  after(async () => {
    if (blocker) await closeServer(blocker);
  });

  it("skips the occupied first port and binds a later free one", async () => {
    const listener = await bindLoopback([P1, P2, P3], 1000);
    assert.ok(listener, "expected a listener on a free port");
    try {
      assert.notEqual(
        listener!.port,
        P1,
        "must not have bound the occupied port",
      );
      assert.ok(
        [P2, P3].includes(listener!.port),
        "bound one of the fallback ports",
      );
    } finally {
      await listener!.close();
    }
  });

  it("binds 127.0.0.1 only (loopback) and delivers the code without echoing it", async () => {
    const listener = await tryBindPort(P2, 2000);
    // P2 might be busy on a shared runner; if so, try P3.
    const l: LoopbackListener | null =
      listener ?? (await tryBindPort(P3, 2000));
    assert.ok(l, "expected to bind a fallback port");
    try {
      const wait = l!.waitForCode();
      // Hit the loopback callback like the browser would.
      const res = await fetch(
        `http://127.0.0.1:${l!.port}/callback?code=THECODE&state=THESTATE`,
      );
      const body = await res.text();
      assert.equal(res.status, 200);
      // The HTML page must NEVER contain the raw authorization code.
      assert.ok(!body.includes("THECODE"), "callback page leaked the code");
      const result = await wait;
      assert.equal(result.code, "THECODE");
      assert.equal(result.state, "THESTATE");
    } finally {
      await l!.close();
    }
  });

  it("returns null when every requested port is busy", async () => {
    // Occupy two ephemeral ports (:0 → OS-assigned) and ask bindLoopback for
    // exactly those — every one is busy, so it must fall through to null.
    const a = await occupy(0);
    const b = await occupy(0);
    const portA = (a.address() as { port: number }).port;
    const portB = (b.address() as { port: number }).port;
    try {
      const listener = await bindLoopback([portA, portB], 500);
      assert.equal(listener, null, "all busy → null (paste fallback)");
    } finally {
      await closeServer(a);
      await closeServer(b);
    }
  });

  it("callback with ?error= rejects the wait (no code)", async () => {
    const l = (await tryBindPort(P2, 2000)) ?? (await tryBindPort(P3, 2000));
    assert.ok(l, "expected to bind a fallback port");
    try {
      const wait = l!.waitForCode();
      // Attach the rejection expectation BEFORE firing the request so the
      // rejection is never transiently unhandled (Node's runner fails on that).
      const rejected = assert.rejects(wait, /access_denied/);
      const res = await fetch(
        `http://127.0.0.1:${l!.port}/callback?error=access_denied`,
      );
      assert.equal(res.status, 400);
      await rejected;
    } finally {
      await l!.close();
    }
  });
});
