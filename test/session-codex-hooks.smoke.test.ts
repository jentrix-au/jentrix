import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapCodexHook } from "../src/session-host/session-codex-hooks.js";

describe("Codex lifecycle hook mapping", () => {
  it("maps prompts, tools, assistant output, and lifecycle without usage", () => {
    assert.deepEqual(
      mapCodexHook("UserPromptSubmit", { prompt: "Build it", model: "gpt-5" }),
      {
        events: [{ kind: "user_message", payload: { text: "Build it" } }],
        modelId: "gpt-5",
      },
    );
    assert.deepEqual(
      mapCodexHook("PostToolUse", {
        tool_name: "shell",
        tool_input: { command: "pnpm test" },
        tool_response: { exit_code: 0 },
      }).events,
      [
        {
          kind: "tool_call",
          payload: { name: "shell", input: { command: "pnpm test" } },
        },
        {
          kind: "tool_result",
          payload: { name: "shell", result: { exit_code: 0 } },
        },
      ],
    );
    assert.deepEqual(
      mapCodexHook("Stop", { last_assistant_message: "Done" }).events,
      [{ kind: "assistant_message", payload: { text: "Done" } }],
    );
    assert.equal(
      mapCodexHook("SessionEnd", { session_id: "thread-1" }).events[0]?.kind,
      "session",
    );
    assert.equal(
      mapCodexHook("Stop", { last_assistant_message: "Done" }).events.some(
        (event) => event.kind === "usage",
      ),
      false,
    );
  });
});
