import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearOAuthSession,
  CONFIG_FILE_MODE,
  ConfigError,
  readConfigFile,
  saveOAuthSession,
  writeConfigFile,
  type ConfigFileReader,
  type ConfigFileWriter,
  type JentrixConfigFile,
  type JentrixOAuthRecord,
} from "../src/config";

const PATH = "/home/u/.config/stacks/config.json";

/** An in-memory fs pair (reader + writer) that models the atomic rename. */
function memFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const modes = new Map<string, number>();
  const writes: { path: string; mode: number }[] = [];
  const reader: ConfigFileReader = {
    readFileSync(path: string) {
      const v = files.get(path);
      if (v === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return v;
    },
  };
  const writer: ConfigFileWriter = {
    mkdirSync() {
      /* no-op in mem */
    },
    writeFileSync(
      path: string,
      data: string,
      options: { mode: number; flag: "wx" },
    ) {
      // Model O_EXCL: `wx` refuses to overwrite an existing file.
      assert.equal(options.flag, "wx", "temp write must be exclusive (wx)");
      assert.equal(
        files.has(path),
        false,
        "wx must not reuse an existing file",
      );
      files.set(path, data);
      modes.set(path, options.mode);
      writes.push({ path, mode: options.mode });
    },
    chmodSync(path: string, mode: number) {
      modes.set(path, mode);
    },
    renameSync(from: string, to: string) {
      const v = files.get(from);
      assert.notEqual(v, undefined, "rename source must exist");
      files.set(to, v!);
      modes.set(to, modes.get(from) ?? 0);
      files.delete(from);
    },
  };
  return { files, modes, writes, reader, writer };
}

const OAUTH: JentrixOAuthRecord = {
  refreshToken: "tmr_refresh_1",
  expiresAt: "2030-01-01T00:00:00.000Z",
  clientId: "https://tm.jentrix.ai/oauth/stacks-cli.json",
  tokenEndpoint: "https://tm.jentrix.ai/oauth/token",
  scope: "read write",
};

describe("writeConfigFile — atomic + 0600", () => {
  it("writes via a UNIQUE exclusive temp file renamed over the target, at mode 0600", () => {
    const fs = memFs();
    const config: JentrixConfigFile = {
      token: "tmo_a",
      url: "https://x/api/mcp",
    };
    writeConfigFile(PATH, config, fs.writer);

    // Exactly one write, to a *.tmp.<pid>.<rand> path (not a fixed name), 0600,
    // exclusive (wx enforced in the mem writer), then renamed onto PATH.
    assert.equal(fs.writes.length, 1);
    assert.match(
      fs.writes[0].path,
      new RegExp(`^${PATH.replace(/[.]/g, "[.]")}[.]tmp[.]\\d+[.][0-9a-f]+$`),
    );
    assert.notEqual(
      fs.writes[0].path,
      `${PATH}.tmp`,
      "temp name must be unique, not fixed",
    );
    assert.equal(fs.writes[0].mode, CONFIG_FILE_MODE);
    assert.equal(CONFIG_FILE_MODE, 0o600);
    // The temp file was swapped away; the final file is 0600.
    assert.equal(
      fs.files.has(fs.writes[0].path),
      false,
      "temp file swapped away",
    );
    assert.equal(fs.modes.get(PATH), CONFIG_FILE_MODE);
    assert.deepEqual(JSON.parse(fs.files.get(PATH)!), config);
    // Trailing newline (POSIX-friendly).
    assert.ok(fs.files.get(PATH)!.endsWith("\n"));
  });
});

describe("saveOAuthSession — rotation storage", () => {
  it("stores the access token in `token` and the record in `oauth`", () => {
    const fs = memFs();
    saveOAuthSession(
      PATH,
      {
        accessToken: "tmo_access_1",
        url: "https://tm.jentrix.ai/api/mcp",
        oauth: OAUTH,
      },
      { reader: fs.reader, writer: fs.writer },
    );
    const saved = readConfigFile(PATH, fs.reader);
    assert.equal(saved?.token, "tmo_access_1");
    assert.deepEqual(saved?.oauth, OAUTH);
    assert.equal(saved?.url, "https://tm.jentrix.ai/api/mcp");
  });

  it("PRESERVES unrelated fields (defaults) already on disk", () => {
    const fs = memFs({
      [PATH]: JSON.stringify({
        token: "tmo_old",
        url: "https://old/api/mcp",
        defaults: { workspace: "acme", board: "eng" },
        oauth: {
          refreshToken: "tmr_old",
          expiresAt: "2020-01-01T00:00:00.000Z",
          clientId: OAUTH.clientId,
          tokenEndpoint: OAUTH.tokenEndpoint,
        },
      }),
    });
    const rotated: JentrixOAuthRecord = {
      ...OAUTH,
      refreshToken: "tmr_refresh_2",
    };
    saveOAuthSession(
      PATH,
      { accessToken: "tmo_access_2", oauth: rotated },
      { reader: fs.reader, writer: fs.writer },
    );
    const saved = readConfigFile(PATH, fs.reader);
    // New pair persisted…
    assert.equal(saved?.token, "tmo_access_2");
    assert.equal(saved?.oauth?.refreshToken, "tmr_refresh_2");
    // …old refresh token GONE (not left behind anywhere)…
    const rawFile = fs.files.get(PATH)!;
    assert.ok(!rawFile.includes("tmr_old"), "old refresh token still on disk");
    assert.ok(!rawFile.includes("tmo_old"), "old access token still on disk");
    // …and the unrelated `defaults` survived.
    assert.deepEqual(saved?.defaults, { workspace: "acme", board: "eng" });
    // No `url` passed → the prior url is preserved (not blanked).
    assert.equal(saved?.url, "https://old/api/mcp");
  });

  it("rotation is atomic: the target only ever holds a complete file", () => {
    // The writer models writeFileSync(tmp) then renameSync(tmp,PATH); at no
    // point does PATH hold a partial write. Assert the temp path is the only
    // thing ever written, and the final file round-trips.
    const fs = memFs({
      [PATH]: JSON.stringify({ token: "tmo_a", oauth: OAUTH }),
    });
    saveOAuthSession(
      PATH,
      { accessToken: "tmo_b", oauth: { ...OAUTH, refreshToken: "tmr_b" } },
      { reader: fs.reader, writer: fs.writer },
    );
    assert.equal(fs.writes.length, 1);
    assert.ok(
      fs.writes[0].path.startsWith(`${PATH}.tmp.`),
      "wrote to a temp sibling",
    );
    // Round-trips cleanly (no torn JSON).
    assert.doesNotThrow(() => readConfigFile(PATH, fs.reader));
  });
});

describe("clearOAuthSession — logout", () => {
  it("drops token + oauth, keeps the rest", () => {
    const fs = memFs({
      [PATH]: JSON.stringify({
        token: "tmo_x",
        url: "https://x/api/mcp",
        defaults: { workspace: "acme" },
        oauth: OAUTH,
      }),
    });
    const result = clearOAuthSession(PATH, {
      reader: fs.reader,
      writer: fs.writer,
    });
    assert.equal(result.hadToken, true);
    const saved = readConfigFile(PATH, fs.reader);
    assert.equal(saved?.token, undefined);
    assert.equal(saved?.oauth, undefined);
    assert.equal(saved?.url, "https://x/api/mcp");
    assert.deepEqual(saved?.defaults, { workspace: "acme" });
    // The cleared token is not left in the file.
    assert.ok(!fs.files.get(PATH)!.includes("tmo_x"));
    assert.ok(!fs.files.get(PATH)!.includes("tmr_refresh_1"));
  });

  it("missing file is a no-op (already logged out)", () => {
    const fs = memFs();
    const result = clearOAuthSession(PATH, {
      reader: fs.reader,
      writer: fs.writer,
    });
    assert.equal(result.hadToken, false);
    assert.equal(fs.writes.length, 0);
  });

  it("reports hadToken=false when nothing was stored", () => {
    const fs = memFs({ [PATH]: JSON.stringify({ url: "https://x/api/mcp" }) });
    const result = clearOAuthSession(PATH, {
      reader: fs.reader,
      writer: fs.writer,
    });
    assert.equal(result.hadToken, false);
  });
});

describe("readConfigFile — oauth record validation", () => {
  const fsWith = (content: string): ConfigFileReader => ({
    readFileSync: () => content,
  });

  it("parses a valid oauth record", () => {
    const parsed = readConfigFile(
      PATH,
      fsWith(JSON.stringify({ token: "tmo_a", oauth: OAUTH })),
    );
    assert.deepEqual(parsed?.oauth, OAUTH);
  });

  it("tolerates a missing scope (optional)", () => {
    const { scope, ...noScope } = OAUTH;
    const parsed = readConfigFile(
      PATH,
      fsWith(JSON.stringify({ token: "tmo_a", oauth: noScope })),
    );
    assert.equal(parsed?.oauth?.scope, undefined);
    assert.equal(parsed?.oauth?.refreshToken, OAUTH.refreshToken);
  });

  it("rejects an oauth block missing a required field (exit 2)", () => {
    try {
      readConfigFile(
        PATH,
        fsWith(JSON.stringify({ oauth: { refreshToken: "tmr_x" } })),
      );
      assert.fail("expected ConfigError");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /oauth\./);
    }
  });

  it("rejects a non-object oauth value (exit 2)", () => {
    assert.throws(
      () => readConfigFile(PATH, fsWith(JSON.stringify({ oauth: "nope" }))),
      (e) => e instanceof ConfigError && e.exitCode === 2,
    );
  });
});
