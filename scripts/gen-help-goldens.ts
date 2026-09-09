import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { registerSessionCommand } from "../src/commands/session";
import { registerTaskContextCommands } from "../src/commands/task-context";
import type { SessionCommandDeps } from "../src/session/deps";

import { ALIASES, FLAG_RENAMES } from "../src/commands/aliases";
import {
  buildProgram,
  type AliasConfig,
  type TreeRuntime,
} from "../src/commands/build";
import type { ToolCommandDeps } from "../src/commands/tool";
import { loadSurface } from "../src/surface";

const GOLDENS = [
  { file: "help-root.txt", command: [] },
  { file: "help-session.txt", command: ["session"] },
  { file: "help-session-connect.txt", command: ["session", "connect"] },
  { file: "help-session-align.txt", command: ["session", "align"] },
  { file: "help-task.txt", command: ["task"] },
  { file: "help-agent.txt", command: ["agent"] },
  { file: "help-task-update.txt", command: ["task", "update"] },
  // JEN-495 (D3/D4): the hand-written compositions, pinned like every other
  // command. They are registered on the SESSION program below, because they
  // need session deps (folder binding, caller) that the generated tree has no
  // place for.
  { file: "help-task-context.txt", command: ["task", "context"] },
  { file: "help-subtask-list.txt", command: ["subtask", "list"] },
] as const;

const manifest = loadSurface(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);
const config: AliasConfig = { aliases: ALIASES, flagRenames: FLAG_RENAMES };
const runtime: TreeRuntime = {
  deps: {} as ToolCommandDeps,
  onExit: () => {
    throw new Error("generated help must not run a CLI action");
  },
};
const program = buildProgram(manifest, config, runtime);
const sessionProgram = new Command().name("jentrix");
registerSessionCommand(
  sessionProgram,
  {} as SessionCommandDeps,
  runtime.onExit,
);
registerTaskContextCommands(
  sessionProgram,
  {} as SessionCommandDeps,
  runtime.onExit,
);

for (const { file, command } of GOLDENS) {
  const handWritten =
    command[0] === "session" ||
    (command[0] === "task" && command[1] === "context") ||
    (command[0] === "subtask" && command[1] === "list");
  let selected = handWritten ? sessionProgram : program;
  for (const segment of command) {
    const next = selected.commands.find(
      (candidate) => candidate.name() === segment,
    );
    if (!next) {
      throw new Error(
        `Cannot generate ${file}: command "${command.join(" ")}" is missing`,
      );
    }
    selected = next;
  }
  writeFileSync(
    new URL(`../test/golden/${file}`, import.meta.url),
    selected.helpInformation(),
  );
}

console.log(`Wrote ${GOLDENS.length} CLI help goldens`);
