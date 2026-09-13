# The plugin synchronization guard

Every official Jentrix plugin — Claude Code, Codex, OpenCode and Pi (the
last two enrolled in M2, JEN-537) — must deliver the same corrected behaviour
in the same logical change and the same compatible release set. `pnpm check:plugin-sync` is the
guard that makes a fix or feature reaching only one plugin a red build rather
than a customer report (prds/opencode-pi-plugins-prd.md §5.1, G01–G07).

## What one change needs

1. **Code**, in the shared engine (`src/session`, `src/session-host`,
   `src/commands`) or in a host's adapter/package.
2. **Tests** — the shared conformance suite
   (`test/plugin-sync-conformance.test.ts`) runs the common semantic scenarios
   through every enrolled adapter; extend it when a behaviour changes.
3. **An impact record** in `plugins/changes/` (format in its README): the
   behaviour ids touched, the changed paths, and for EVERY official host —
   enrolled and planned — one disposition:
   - `shared-fix-applied` — shared code every enrolled adapter runs;
   - `adapter-fix-applied` — that host's adapter or package changed (the
     guard refuses this label when the diff never touched the host);
   - `verified-unaffected` — with executable evidence and a rationale;
   - `not-applicable` — a demonstrably absent native capability, with host,
     version, source and reviewer;
   - `planned` — planned hosts only, with the task that enrolls them.
4. **Docs**, in the same pull request.

The record is versioned with the change: the guard derives the diff from the
merge base to the candidate (`--base <ref>`, default `origin/main`) and refuses
a plugin-relevant change with no record added or modified in that diff. A
path filter, a removed matrix entry or a self-declared "unaffected" label
cannot skip it. Changes to the registry, the guard, the records or the fixtures
need a code owner's review like any other guarded file.

## The registry

`plugins/registry.json` is the one authoritative list: official hosts (with
`status: enrolled | planned`), the seven workflows, the behaviour ids
P01–P17/R01–R08, the shared behaviour revision, the semantic-schema revision,
each host's owned/adapter paths, the shared paths, the required checks and
the conformance scenario ids. The workflow generator reads it, so an enrolled
host that lacks a manifest, hooks, entry, package or any of the seven
generated entrypoints fails G01; a planned host with a package on disk is
refused until it enrolls atomically with adapter, resources and evidence.

## Behaviour revision and packaged resources

`pnpm sync:plugin-meta` stamps `jentrix.behaviorRevision`, the semantic-schema
revision and the sha256 over each host's generated resources into the package
manifests. The guard refuses a stale stamp in the tree, and in `--packed
<dir>` mode inspects the exact tarballs a release will publish: a missing host
package, a stale resource or a mixed behaviour revision refuses the release
before anything is uploaded. `jentrix session doctor` reports the CLI's,
the installed package's and the provider-loaded copy's revisions side by side
(`behaviour claude`/`behaviour codex`/`behaviour opencode`/`behaviour pi`)
and offers a reinstall scoped to the one provider that is stale.

## The two plugin hosts (M2)

OpenCode and Pi have no lifecycle-hook mechanism that runs a command: their
plugins run IN-PROCESS. `@jentrix/plugin-opencode` (loaded through a managed
loader file in OpenCode's global plugins folder) and `@jentrix/plugin-pi` (a
Pi package registered with `pi install`) append the SAME provider ledger the
Claude/Codex hook forwarder writes — `~/.config/stacks/<host>-sessions/
hooks.ndjson`, one `{event, at, payload, env}` line per observed event —
using the lifecycle vocabulary the watch host already understands
(`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `PreCompact`,
`PostCompact`, `SessionEnd`) plus `TurnStart`/`TurnEnd` (turn intervals),
`Usage` (one line per host token receipt) and `Error`. The adapters
`src/session-host/session-opencode-hooks.ts` and `session-pi-hooks.ts` map
those lines onto the common envelope; the token semantics they encode (which
host subtracts cache or reasoning from its totals, which ids identify a
receipt, why replayed fork history yields nothing) were settled by the S0b
native proof and are pinned by `test/session-plugin-hooks.test.ts`, while
`test/plugin-runtime-opencode.test.ts` and `test/plugin-runtime-pi.test.ts`
replay the recorded host fixtures through the plugin code itself.

## Testing the guard

`test/plugin-sync.test.ts` copies the tree the guard reads into a fixture and
proves it goes red for an omitted host, a hand-edited generated workflow, a
common fix declared for one adapter, a shared change mislabelled unaffected,
a dropped required check, stale packed metadata, an empty packed set and a
replayed verification — and green for the unmutated candidate. It runs under
`pnpm test`, which CI requires.
