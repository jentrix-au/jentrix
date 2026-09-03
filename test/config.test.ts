import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfigError,
  DEFAULT_MCP_URL,
  configPathFor,
  findProjectConfigPath,
  readConfigFile,
  resolveConfig,
  resolveConfigPath,
  type ConfigInputs,
} from "../src/config";

const noEnv: Record<string, string | undefined> = {};

function inputs(overrides: Partial<ConfigInputs>): ConfigInputs {
  return { env: noEnv, file: null, ...overrides };
}

describe("resolveConfig — precedence (flag > env > file > default)", () => {
  const flagToken = "tm_flag";
  const envToken = "tm_env";
  const fileToken = "tm_file";
  const flagUrl = "https://flag.example/api/mcp";
  const envUrl = "https://env.example/api/mcp";
  const fileUrl = "https://file.example/api/mcp";
  const fullEnv = { STACKS_TOKEN: envToken, STACKS_MCP_URL: envUrl };
  const fullFile = { token: fileToken, url: fileUrl };

  const table: {
    name: string;
    in: ConfigInputs;
    token: string;
    tokenSource: string;
    url: string;
    urlSource: string;
  }[] = [
    {
      name: "flag wins over env and file",
      in: inputs({ flagToken, flagUrl, env: fullEnv, file: fullFile }),
      token: flagToken,
      tokenSource: "flag",
      url: flagUrl,
      urlSource: "flag",
    },
    {
      name: "env wins over file",
      in: inputs({ env: fullEnv, file: fullFile }),
      token: envToken,
      tokenSource: "env",
      url: envUrl,
      urlSource: "env",
    },
    {
      name: "file wins over defaults",
      in: inputs({ file: fullFile }),
      token: fileToken,
      tokenSource: "file",
      url: fileUrl,
      urlSource: "file",
    },
    {
      name: "URL falls back to the production default",
      in: inputs({ env: { STACKS_TOKEN: envToken } }),
      token: envToken,
      tokenSource: "env",
      url: DEFAULT_MCP_URL,
      urlSource: "default",
    },
    {
      name: "token and URL resolve independently (flag token + env URL)",
      in: inputs({ flagToken, env: { STACKS_MCP_URL: envUrl } }),
      token: flagToken,
      tokenSource: "flag",
      url: envUrl,
      urlSource: "env",
    },
    {
      name: "empty-string env vars are treated as unset",
      in: inputs({
        env: { STACKS_TOKEN: "", STACKS_MCP_URL: "  " },
        file: fullFile,
      }),
      token: fileToken,
      tokenSource: "file",
      url: fileUrl,
      urlSource: "file",
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const resolved = resolveConfig(row.in);
      assert.equal(resolved.token, row.token);
      assert.equal(resolved.tokenSource, row.tokenSource);
      assert.equal(resolved.url, row.url);
      assert.equal(resolved.urlSource, row.urlSource);
    });
  }

  it("passes the config file `defaults` through untouched", () => {
    const defaults = { workspace: "acme", board: "eng" };
    const resolved = resolveConfig(inputs({ flagToken, file: { defaults } }));
    assert.deepEqual(resolved.defaults, defaults);
  });
});

describe("resolveConfig — failure modes", () => {
  it("missing token everywhere → ConfigError with exit 7 and an actionable message", () => {
    try {
      resolveConfig(inputs({}));
      assert.fail("expected ConfigError");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.exitCode, 7);
      // Actionable: names every way to provide a token + where to mint one.
      assert.match(e.message, /jentrix login/);
      assert.match(e.message, /--token/);
      assert.match(e.message, /STACKS_TOKEN/);
      assert.match(e.message, /config\.json/);
      assert.match(e.message, /\/account\/tokens/);
    }
  });

  it("invalid URL → ConfigError with exit 2 naming the source", () => {
    try {
      resolveConfig(inputs({ flagToken: "tm_x", flagUrl: "not a url" }));
      assert.fail("expected ConfigError");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /invalid MCP URL/);
      assert.match(e.message, /--url/);
    }
  });

  it("never leaks token values into error messages", () => {
    const secret = "tm_super_secret_value";
    try {
      resolveConfig(inputs({ flagToken: secret, flagUrl: "://broken" }));
      assert.fail("expected ConfigError");
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes(secret), "token leaked into message");
    }
  });
});

describe("readConfigFile — thin fs edge", () => {
  const path = "/home/user/.config/stacks/config.json";
  const fsWith = (content: string) => ({
    readFileSync: (p: string) => {
      assert.equal(p, path);
      return content;
    },
  });
  const missingFs = {
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT: no such file"), {
        code: "ENOENT",
      });
    },
  };

  it("missing file → null (not an error)", () => {
    assert.equal(readConfigFile(path, missingFs), null);
  });

  it("valid file → parsed shape (unknown keys dropped)", () => {
    const parsed = readConfigFile(
      path,
      fsWith(
        JSON.stringify({
          token: "tm_file",
          url: "https://file.example/api/mcp",
          defaults: { workspace: "acme" },
          futureKey: true,
        }),
      ),
    );
    assert.deepEqual(parsed, {
      token: "tm_file",
      url: "https://file.example/api/mcp",
      defaults: { workspace: "acme" },
    });
  });

  it("malformed JSON → ConfigError (exit 2) with path + reason, not a stack trace", () => {
    try {
      readConfigFile(path, fsWith("{ token: nope"));
      assert.fail("expected ConfigError");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /not valid JSON/);
      assert.ok(e.message.includes(path), "message names the file path");
    }
  });

  it("non-object root → ConfigError showing the expected shape", () => {
    try {
      readConfigFile(path, fsWith('"just a string"'));
      assert.fail("expected ConfigError");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /JSON object/);
    }
  });

  it("wrong-typed fields → ConfigError naming the field", () => {
    for (const [content, field] of [
      ['{"token": 42}', "token"],
      ['{"url": ["x"]}', "url"],
      ['{"defaults": "nope"}', "defaults"],
    ] as const) {
      try {
        readConfigFile(path, fsWith(content));
        assert.fail(`expected ConfigError for ${content}`);
      } catch (e) {
        assert.ok(e instanceof ConfigError);
        assert.equal(e.exitCode, 2);
        assert.ok(
          e.message.includes(`"${field}"`),
          `message names "${field}": ${e.message}`,
        );
      }
    }
  });

  it("unreadable file (non-ENOENT) → ConfigError, not a throw-through", () => {
    try {
      readConfigFile(path, {
        readFileSync: () => {
          throw Object.assign(new Error("EACCES: permission denied"), {
            code: "EACCES",
          });
        },
      });
      assert.fail("expected ConfigError");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /cannot read config file/);
    }
  });
});

describe("configPathFor", () => {
  it("is ~/.config/stacks/config.json", () => {
    assert.equal(
      configPathFor("/home/andrew"),
      "/home/andrew/.config/stacks/config.json",
    );
  });
});

describe("project-local config discovery (AGE-952)", () => {
  const exists = (present: string[]) => (path: string) =>
    present.includes(path);

  it("finds .stacks/config.json in the starting directory", () => {
    assert.equal(
      findProjectConfigPath("/w/app", exists(["/w/app/.stacks/config.json"])),
      "/w/app/.stacks/config.json",
    );
  });

  it("walks up to an ancestor and stops at the first hit", () => {
    assert.equal(
      findProjectConfigPath(
        "/w/app/src/deep",
        exists(["/w/app/.stacks/config.json", "/w/.stacks/config.json"]),
      ),
      "/w/app/.stacks/config.json",
    );
  });

  it("returns null at the filesystem root without looping", () => {
    assert.equal(findProjectConfigPath("/w/app", exists([])), null);
  });

  it("resolveConfigPath prefers the project file over the home file", () => {
    assert.equal(
      resolveConfigPath(
        "/w/app",
        "/home/u",
        exists(["/w/.stacks/config.json"]),
      ),
      "/w/.stacks/config.json",
    );
    assert.equal(
      resolveConfigPath("/w/app", "/home/u", exists([])),
      "/home/u/.config/stacks/config.json",
    );
  });
});
