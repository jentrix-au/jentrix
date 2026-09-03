import { readFileSync, writeFileSync } from "node:fs";

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
  { file: "help-task.txt", command: ["task"] },
  { file: "help-agent.txt", command: ["agent"] },
  { file: "help-task-update.txt", command: ["task", "update"] },
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

for (const { file, command } of GOLDENS) {
  let selected = program;
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
