# Testing AI agent plugins against Jentrix

This runbook covers setup, deterministic checks, package validation, native
workflows, failure injection and handoff evaluation. Its output is a reproducible
evidence ledger with observable results for each claimed capability. Apply it to new hosts, common behavior
changes, installation changes and regression fixes. For a small custom workflow,
test its declared capabilities and coexistence; do not pretend it implements an
official lifecycle adapter.

The deployed baseline covers the four official integrations: Claude Code and
Codex (M1) and OpenCode and Pi (M2). Use this runbook to validate changes
against that baseline and to establish a new plugin's declared support. A
deployment does not prove an untested operating system, third-party plugin or
new host.
Keep one explicit requirement matrix for the change; record unsupported and
unexercised cases separately from passing cases.

## Prerequisites and baseline

Use Node.js 20 or later, pnpm 11 for the open-client development checkout, and
the exact Claude Code, Codex, OpenCode or Pi build you intend to support. Prepare a dedicated
test workspace and disposable repository/profile with synthetic content. Sign
in with an account that can read and write that workspace; keep credentials out
of commands and recorded artifacts.

For an ordinary installed-client baseline, the setup command is:

```bash
npx --yes --package @jentrix/cli@latest jentrix setup
```

It previews installation and configuration before confirmation and opens browser
sign-in. For a candidate trial, load the candidate packages in the isolated
profile instead of allowing the latest globally installed plugin to supply the
behavior being tested. Check loaded resources and hook trust explicitly.

The M1 client must expose semantic checkpoint, explicit-final, uncommitted-output
and artifact-registration commands. Inspect them before starting the trial:

```bash
jentrix --version
jentrix session doctor
jentrix push --help
jentrix session end --help
jentrix artifact register --help
```

Expect `--checkpoint`, `--intent`, `--next` and `--final` on push,
`--preserve-uncommitted` on end, and an artifact registration subcommand.
An older installation can lack these while the service has M1. Record that
version mismatch; do not credit a fallback command with testing the missing feature.

## 1. Identify and isolate the candidate

Before running native agents, record:

- Client commit, branch, scoped dirty-state/content digest, service contract
  identity and existing unrelated changes. Record the server commit too when
  testing a service build you own. A branch name or package version alone is not an
  exact candidate. Never commit another person's work just to get a clean SHA.
- Every package version and tarball SHA-256, behavior revision, semantic-schema
  revision, CLI compatibility range and service contract identity. Distinguish
  the source, installed and provider-loaded copies.
- Host version, model/backend, Node/package-manager version, OS, shell, profile
  and installation scope. Record how the actual plugin was loaded.
- Fixture endpoint/workspace, synthetic tasks and repositories, capture/skeleton
  settings, hook trust and intended failure-injection points.
- Each operation pre-authorized for the trial: fixture edits, fixture commits,
  task writes, typed uploads, profile installation and capture changes. Keep
  publishing and real-account changes outside that scope unless authorized.

Use an isolated profile and fixture repository/service when possible. A local
clone with production credentials is not isolated service data. Use synthetic
secrets as redaction sentinels, not real credentials or personal transcripts.
Keep credentials out of argv, recorded prompts and checked-in test fixtures.
Name the resources the harness creates and provide cleanup limited to those
resources; leave unrelated sessions, profiles and services alone.

A headless native host, a manually scripted CLI flow, a session-only plugin load
and a real installed marketplace plugin are different test modes. Record which
one ran. Disable ambient copies of the plugin within the isolated trial where
needed to prevent an older hook or skill from supplying the behavior being
claimed for the candidate. Do not change a person's global hook trust as a
test-harness shortcut.

## 2. Run deterministic checks first

Read the selected repository's package scripts. In the public client checkout,
the current contributor workflow includes:

```bash
pnpm typecheck
pnpm test
pnpm validate:examples
pnpm check:plugin-sync
pnpm build
```

For changed workflow sources, generate and stamp before those checks:

```bash
pnpm gen:workflows
pnpm sync:plugin-meta
```

Test the shared contract through every enrolled adapter. Fixtures should cover
identity, lifecycle normalization, usage deduplication, missing fields, final
delivery, checkpoint indexing, skeleton accounting and declared truncation.
Keep parser/classifier mirrors and their pinned corpus synchronized when a
server also validates the format. Generated-text equality proves packaging
consistency; it does not prove that an agent followed the workflow.

If the change also affects a service implementation, run that repository's
required checks and use an isolated service fixture. Preserve ordering for any
checks that regenerate shared clients or schemas. Plugin authors using the
hosted service validate its supported API responses and downloaded artifacts;
they do not need private service source or database access. Do not run a build
that applies production migrations merely to validate a plugin document.

## 3. Build and verify the exact packages

The client's `CLI_PACK_SMOKE=1 pnpm test` performs a cold-install package smoke
test. Run it when packaging, scripts or plugin resources change. For native
acceptance, designate one final tarball set and reuse those exact files through
installation and review. If a smoke run packs its own files, do not assume a
later repack has identical identity without checking its hashes.

An explicit three-package packing recipe, from the client checkout, is:

```bash
# Choose a new, empty, absolute destination; replace every example path.
mkdir /absolute/new-candidate
pnpm pack --pack-destination /absolute/new-candidate
pnpm --dir /absolute/jentrix/plugins/claude pack --pack-destination /absolute/new-candidate
pnpm --dir /absolute/jentrix/plugins/codex pack --pack-destination /absolute/new-candidate
pnpm check:plugin-sync --packed /absolute/new-candidate
```

Derive the expected package set from the registry and release train. Planned
hosts do not need fictitious tarballs. Verify the directory actually contains
every expected tarball: a successful packing command with no output files proves
nothing. Hash the files, inspect their manifests and resources, install the set
together into an empty project, then test the installed executable. Preserve
the original files. A source change after packing requires a new identified
candidate and the checks affected by that change.

Exercise negative guard cases in disposable copies: omitted host/resource,
stale generated entry, unilateral common fix, unsupported unaffected claim,
incompatible real-tarball schema/range/revision and removed required check.
Keep a green unmodified control. A JSON mock is not a test that the guard can
read an actual npm tarball.

Do not republish, retag or install globally as a consequence of this procedure.
Publication and changes to a person's real profile require authorization for
those actions, independently of permission to run an isolated trial.

## 4. Exercise workflows in the native host

Invoke the **packaged native entrypoint**, not merely the CLI equivalent, for
each of connect, align, plan, checkpoint, review, status and end. Claude Code
uses `/jentrix-` followed by the workflow name; Codex uses `$jentrix-` followed
by the workflow name. Invoke them in the agent chat. Check the retained record
as well as the assistant's response.

For a separate CLI control trial, the core connection sequence inside a live
Codex session is shown below. Replace the example workspace and task first;
use `--provider claude` on connect and align for a Claude Code trial.

```bash
jentrix folder align --workspace example-test-workspace
jentrix session connect --provider codex
jentrix session align --provider codex --task JEN-123
jentrix task context --task JEN-123
jentrix session status
```

Prepare a prompt, goal, plan, checkpoint and final output with synthetic trial
content. These are files you create for the trial, not prerequisite documents.
Replace every example path. Record actual checks configured in that checkout:

```bash
jentrix push prompt /absolute/trial/prompt.md
jentrix push goal /absolute/trial/goal.md
jentrix push plan /absolute/trial/plan.md
jentrix push log --from-cmd 'pnpm test'
jentrix push report --checkpoint handoff --intent 'Verify the selected plugin' --next 'Review stored evidence' /absolute/trial/checkpoint.md
jentrix push report --final /absolute/trial/output.md
jentrix session end
```

Use `session end --preserve-uncommitted` for the separate case that authorizes
uploading the trial checkout's dirty changes. Follow returned artifact IDs and
download URLs; compare stored content with the known input. A CLI control trial
does not count as invoking a packaged native workflow.

| Scenario | Observable result |
| --- | --- |
| Plan before implementation | PLAN exists before edits; prompt and goal have provenance; declined or pending proposals create no unauthorized cards |
| Headless plan | No invented approval or indefinite choice wait; pending decisions named; authorized existing work can continue |
| Headless end with pending mints | Seed a real authorized GAP/ISSUE artifact; leave its optional mint unanswered; artifact survives, no card is minted, live host closes without resuming to answer a question |
| Align/task switch | Correct workspace/task and owner; no sibling identity; prior attribution is flushed or explicitly unflushed |
| Checkpoint/late clarification | New scope and rejected alternatives survive with TRACE off; hook requests a checkpoint, agent supplies the semantic content |
| Review | Reader opens cited bodies and outputs, distinguishes evidence from claims, makes no edits or unapproved comments/acceptance |
| Status | Loaded version, live host, receipt freshness and coverage match the actual trial mode |
| Normal end | Output was acknowledged before seal; final telemetry and readable RUN_SUMMARY exist; post-seal writes refuse |
| Refused end then comply | Missing/stale evidence is named; host keeps recording during repair; a valid new receipt covers the actual closing candidate |

The no-mint-candidates happy path does not test the unanswered-mint branch.
Likewise, an external close-by-id proves that recovery path, not that a resumed
model successfully executed its end workflow. Give trial setup instructions
clear lifetimes; an unconditional “never end” rule can invalidate a later
resumption test by making the model refuse the intended action.

## 5. Test evidence against real failure modes

### Verification receipts

Run checks through `jentrix push log --from-cmd` from the intended checkout root,
using literal gate arguments and the actual configured script/runner. The
M1 verifier binds runner/script or reviewed-wrapper identity, successful
exit, working directory, repository revision and exact tree digest. A null
digest is unknown, not a clean tree and not a wildcard.

Use an intentionally failing fixture test and a separate passing test in
another checkout. Execute the commands through the **real shell**, then the
real receipt builder, parser and server evidence floor. Test at least:

| Probe | Required interpretation |
| --- | --- |
| Failing gate followed by `\|\| true`, a pipe, semicolon or background operator | The final shell exit cannot certify the failed gate |
| Failing gate, trailing `# comment`, then newline and `true` | The comment must not hide the second command |
| `node --test "$FLAG"` with FLAG set to `--help` | Help output is not test execution; unresolved expansion cannot certify a gate |
| Variable expanded to another checkout's passing test; `cd`, scope flags or outside paths | Running elsewhere cannot verify this checkout |
| Help/version/listing flags, including after a package script's `--` | Exit 0 without executing the gate is not verification |
| Script name/body mismatch or altered reviewed wrapper | Words or a renamed executable cannot grant a gate family |
| Successful receipt before the last commit/edit | Stale candidate or tree does not cover the close |
| Same-sized changed binary/untracked content, large files, unreadable files or limits | Changed content changes the digest; incomplete measurement becomes unknown |
| Honest passing gate, literal-dollar argument, one-line trailing comment | Supported literal controls still execute and count |

Keep expected failure distinct from a successful gate. An accepted receipt also
does not prove the test meaningfully exercises the requirement; review its test
body. Legacy logs remain readable without being promoted to structured evidence.

Inspect the verification evidence check (E4) and its **reason**, not just `ok`.
“No gate claims detected” is not positive
proof that any receipt bound. Keep author validation, independent reviewer
checks and quoted historical evidence separately attributed. A prose detector
may misclassify the last two; record that limitation instead of fabricating a
receipt, rewriting the claim to evade detection or silently acknowledging a
required acceptance failure.

### Final output, retry and recovery

Inject each failure at a named boundary and record its timing:

1. Refuse close after provisional output, change the final answer, then retry.
   Verify predecessor chaining and exactly one current final.
2. Accept an upload server-side, drop its acknowledgement, then kill/restart the
   local host. Retry must preserve the same attempt, payload bytes and
   supersedes reference. An acknowledged record should be reused.
3. Send competing finalizations through independent processes against the real
   fixture service. Read the persisted artifact chain through the supported API
   after both finish; service maintainers can also inspect their fixture DB. A
   sequential mock cannot demonstrate transactional concurrency safety.
4. Submit unknown/wrong-attempt final acknowledgements, and a valid acknowledgement
   superseded by an explicit final. Check rejection versus disclosed
   reconciliation separately; explicit-final precedence must not validate a
   forged acknowledgement.
5. Interrupt after usage is stored, then recover without the old host/spool.
   Compare the original summary, persisted session and replacement summary: counters,
   coverage, provisional/settled source, final-output identity and measured
   interval. Retained usage must be labelled; the disconnected gap is not
   invented work time. Test resumed-workflow recovery separately.
6. Exercise offline/auth/rate-limit/upload failure and unwritable local durable
   state. Accepted data survives, retries converge and missing/pending delivery
   remains visible. Do not call lost-ack behavior native-tested from unit
   tests alone.

### Artifacts, privacy and accounting

Register selected text, binary, dirty and untracked outputs with known checksums.
Follow every returned download URL and compare actual bytes, MIME and size.
Repeat registration and retry a rate-limited manifest push; check artifact and
manifest identity/convergence, not just exit 0. Exclude unrelated user changes
unless their attribution and upload are authorized.

Exercise image-only prompts, tool calls/results/errors, missing payload fields,
child/fork sessions, large logs/prompts/patches and compaction boundaries. Verify
original/retained sizes, omitted ranges and recoverable references or explicit
unavailability. A log tail is not the full output. Repeated overflow paths must
not inflate purported distinct-file counts.

Test TRACE and skeleton controls independently. Inspect local export queues and
uploaded bodies for synthetic sentinels that consent says must be absent.
Check provider receipts under streaming updates, duplicate delivery, retries,
model changes and missing cache/reasoning fields. Reconcile totals using that
provider's accounting semantics; do not add cumulative snapshots together or
invent zeros, prices or child usage. Token-receipt completeness, event coverage,
capture integrity and human acceptance are separate dimensions.

For recall claims, query the actual retrieval path with stored records and the
needed indexing/embeddings. Show that provisional and superseded outputs are
excluded while the current eligible output remains discoverable. A SQL-string
unit test alone is not native retrieval evidence.

## 6. Verify installation and the claimed support matrix

Repeat applicable native cases for each supported host version/OS/install scope.
Include paths with spaces, restricted PATH and app-launched sessions. Exercise
fresh install, repeat install, dry run, update, rollback and removal. Compare
unrelated config and registrations before/after. Verify the provider-loaded
cache and installed package, the documented hook pin, trust and active-session
behavior. A session-only load does not replace this matrix.

Run hooks-enabled and supported fallback modes separately. Prove hooks fired
from native evidence; a complete token rollup or a readable skill on disk is not
that proof. Preserve provider-controlled trust. When a required trial cannot
run, name the exact missing OS, credential, native permission or fixture
capability. Mark it not exercised; do not relabel it unsupported or passed.

## 7. Evaluate whether another agent can continue

Use fresh readers that receive only the saved Jentrix record and the fixed
questions below, without the producer's chat, scratch notes or an answer key.
For cross-host parity, keep a reader-host × producer-host matrix. Use
read-only access and retain reader prompts, answers and cited artifact IDs.

1. What was the current intent when the session ended?
2. What alternative was rejected, and why?
3. What is the actual output, and is it explicit final or provisional?
4. What verification ran, on which candidate, and what did it establish?
5. What is the recorded next action?
6. Has a human accepted the work, and what remains unknown or unverified?

Score each against independently established fixture facts and the retained
record. Accept an honest record-relative unknown where information is absent;
exact UNKNOWN wording is unnecessary. Do not reward an invented alternative or
infer acceptance from “In review.” Distinguish a hypothetical explanation from
an executed check. Publish the rubric, failures, omissions, evaluator identity
and whether scores are author-assessed or independently assessed. Keep this
evaluation separate from deterministic conformance; six answers do not prove
every lifecycle or installation scenario.

## 8. Record results and hand off

Use one ledger row per requirement, host and scenario. Keep the scenario and
result separate from the test level so a unit pass cannot hide a missing native
trial. A reusable row template is:

```text
Requirement/scenario:
Host version, OS, profile, install scope, hook mode:
Client commit + scoped tree digest; service contract/revision:
Package versions + tarball SHA-256 + behavior/schema revisions:
Fixture and preconditions:
Native action or exact command + cwd:
Expected observable outcome:
Observed outcome and exit code:
Test level: unit | integration | packed | native | fresh-reader
Status: passed | failed | not exercised
Evidence: session/artifact IDs, transcript/read-back/download checksums:
Limitations and exact missing prerequisite:
Reviewer and date:
```

For each official host, record applicability separately: `shared-fix-applied`
means its shared engine changed; `adapter-fix-applied` means its adapter changed;
`verified-unaffected` requires an executable check and rationale;
`not-applicable` requires host/version, absent capability, observation and
reviewer; `planned` identifies a host still awaiting enrollment. Include the
behavior and changed paths. These dispositions do not replace the result field. Do not count skipped tests as passes.
Retain initial failures and their resolution, including harness failures or a
pack command that produced no files. Link targeted reproductions and the final
passing candidate without replacing the historical evidence.

Record checks through the existing CLI attestation path where authorized.
Respect existing authorization for the command, output and Jentrix destination.
If an approval system refuses an upload, inspect the exact output and explain
the established scope before retrying; a generic request to run checks may not
describe the recording clearly enough. If only local execution is allowed,
retain the result locally and mark it as local, not an uploaded attested receipt.
Remote artifact metadata or a returned URL is not proof of body content: verify
the stored/downloaded result.

Before submitting, recheck candidate identity and the applicable ledger rows,
run the required repository/docs checks, file typed findings and remaining gaps,
and store an outcome-first report and handoff checkpoint. Keep cards in the
actual In review column; reviewers do not modify the candidate or self-accept.
Fetch the persisted closing summary and verify telemetry and coverage. A close
over acknowledged gaps does not satisfy the plugin release gate. Nothing in
this runbook authorizes committing, publishing or enabling a host that remains
planned.
