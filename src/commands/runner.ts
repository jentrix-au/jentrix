/** Migration refusal only. The product CLI never discovers or executes Ops. */
import { Command } from "commander";
import { EXIT_CODES } from "../errors";

export function registerRunnerCommand(
  program: Command,
  deps: { writeErr(text: string): void },
  onExit: (code: number) => void,
): void {
  program
    .command("runner", { hidden: true })
    .description("(removed) Ops runner commands are not part of the MVP CLI")
    .argument("[args...]")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      deps.writeErr(
        "OPS_RUNNER_REMOVED: runner operations are not supported by the MVP CLI. Use `jentrix session connect --provider claude|codex` for connected coding sessions; `jentrix --help` lists supported commands.",
      );
      onExit(EXIT_CODES.INVALID_INPUT);
    });
}
