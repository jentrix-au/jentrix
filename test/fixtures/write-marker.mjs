// One concurrent alignment writer, for the marker race test. Separate file
// because the race needs real PROCESSES: the marker API is synchronous, so two
// writers in one thread cannot interleave and would prove nothing.
import { writeAlignmentMarker } from "../../src/commands/session.ts";

const [configPath, repoRoot, key, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // Spin to the shared release instant — a sleep would scatter the writers
  // across milliseconds and the contention this exists to create would vanish.
}
writeAlignmentMarker(
  configPath,
  repoRoot,
  {
    sessionId: key,
    workspaceId: "ws_1",
    taskId: "t_1",
    capture: "off",
    alignedAt: new Date().toISOString(),
  },
  key,
);
