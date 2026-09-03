import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { localConnectionKey } from "../src/commands/session";
import { createSessionRedactor } from "../src/session-host/session-redact";

// ---------------------------------------------------------------------------
// Client-runtime v2 §12.13 — the CLI half of the golden mirror corpus. The
// vectors travel inside the contract bundle (open-client D9) and reach this
// package as `cli/contract-vectors.json`, the CLI's ADOPTED copy; the server
// half (tests/unit/client-mirror-corpus.test.ts) runs the same vectors from the
// bundle builder. Nothing here reaches across the repository boundary.
// ---------------------------------------------------------------------------

interface RedactionVector {
  name: string;
  input: string;
  expected: string;
}
interface ConnectionKeyVector {
  operatorUserId: string;
  installationId: string;
  expected: string;
}

const VECTORS = JSON.parse(
  readFileSync(new URL("../contract-vectors.json", import.meta.url), "utf8"),
) as { redaction: RedactionVector[]; connectionKey: ConnectionKeyVector[] };

describe("golden mirror corpus — CLI redaction (session-host/session-redact.ts)", () => {
  it("adopted a real corpus", () => {
    assert.ok(VECTORS.redaction.length > 10);
    assert.ok(VECTORS.connectionKey.length > 1);
  });
  for (const vector of VECTORS.redaction) {
    it(vector.name, () => {
      // Empty env: the pattern list is the whole behavior, exactly the slice
      // the server mirrors.
      assert.equal(
        createSessionRedactor({ env: {} }).text(vector.input),
        vector.expected,
      );
    });
  }
});

describe("golden mirror corpus — CLI local connection key", () => {
  for (const vector of VECTORS.connectionKey) {
    it(`${vector.operatorUserId} × ${vector.installationId}`, () => {
      assert.equal(
        localConnectionKey(vector.operatorUserId, vector.installationId),
        vector.expected,
      );
    });
  }
});
