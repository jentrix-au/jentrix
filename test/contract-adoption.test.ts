import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BUNDLE_NOTICE,
  SURFACE_NOTICE,
  digestOf,
  serialize,
} from "../scripts/adopt-contract.mjs";

// The adopted contract is INTERNALLY PROVABLE without the bundle: the three
// files this package ships are exact projections of it, so re-assembling the
// bundle from them and hashing it must give the digest contract.json records.
// A hand-edited surface.json, a stale contract-vectors.json or a contract.json
// from a different adoption all fail here — the same way the application's
// sync test fails on a stale contract/mvp.json, but on this side of the
// repository boundary.

const root = new URL("../", import.meta.url);
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, root), "utf8")) as Record<
    string,
    unknown
  >;

describe("the adopted contract", () => {
  const contract = read("contract.json") as {
    surface: string;
    apiRelease: string;
    digest: string;
  };
  const surface = read("surface.json") as {
    _generated: string;
    generatedForToolCount: number;
    tools: unknown[];
  };
  const vectors = read("contract-vectors.json");

  it("records the surface, a semver release and a sha256 digest", () => {
    assert.equal(contract.surface, "mvp");
    assert.match(contract.apiRelease, /^\d+\.\d+\.\d+$/);
    assert.match(contract.digest, /^[0-9a-f]{64}$/);
  });

  it("surface.json is the adoption script's projection", () => {
    assert.equal(surface._generated, SURFACE_NOTICE);
    assert.equal(surface.generatedForToolCount, surface.tools.length);
  });

  it("re-assembles into the recorded digest", () => {
    const bundle = {
      _generated: BUNDLE_NOTICE,
      apiRelease: contract.apiRelease,
      generatedForToolCount: surface.tools.length,
      surface: contract.surface,
      tools: surface.tools,
      vectors,
    };
    assert.equal(digestOf(serialize(bundle)), contract.digest);
  });
});
