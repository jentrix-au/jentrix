# Security policy

The Jentrix open client runs on your machine with your credentials and, once
you trust its hooks, inside your coding agent's session. We treat every
report about it seriously.

## Reporting a vulnerability — privately

**Do not open a public issue for a security problem.** Use GitHub's private
vulnerability reporting for this repository:

> https://github.com/jentrix-au/jentrix/security/advisories/new

It reaches the maintainers only. Include what you can of: the package and
version (`jentrix --version`, or the versions from `jentrix session doctor`),
the provider and OS, steps to reproduce, and what an attacker gains. A
redacted `jentrix session doctor --bundle` file is welcome; it carries no
tokens, no transcript content and no hook bodies.

The same channel is right for a problem in the **hosted service** or its
contract (`https://tm.jentrix.ai/api/mcp`, the OAuth flow): the service is
operated by Jentrix and its fixes ship from the private application
repository, but the report goes through the same private intake.

There is no bug bounty programme at this time.

## What happens next

| Severity | Acknowledged within | Fix or mitigation target |
| --- | --- | --- |
| Critical — credential disclosure, remote code execution through a hook or the installer, a release integrity failure | 1 business day | 7 days |
| High — privilege or scope escalation, tenant boundary defects, transcript or artifact disclosure | 2 business days | 14 days |
| Medium — defects needing unusual configuration or local access | 5 business days | 30 days |
| Low — hardening, informational | 10 business days | next scheduled release |

Targets are commitments of effort, not guarantees; when a fix will miss its
target you hear why and what to do meanwhile. Reporters are credited in the
advisory unless they ask not to be.

## Scope

In scope: `@jentrix/cli`, `@jentrix/plugin-claude`, `@jentrix/plugin-codex`,
the hook declarations they ship, the installer and legacy migration
(`jentrix setup`, `jentrix plugin install`), the session host, the release
workflow in this repository, and the published packages' provenance.

Out of scope: third-party or customer plugins (report those to their
publisher — Jentrix supports the API boundary, not the plugin's behaviour),
the coding-agent products themselves (Claude Code, Codex), and findings that
require an already-compromised machine.

## Supported versions

Security fixes ship in a new version of the affected package on the `latest`
dist-tag; nothing is ever unpublished. Keep the CLI current with
`npm i -g @jentrix/cli`. The hosted API release line a CLI was built against
stays supported for 180 days after its successor is generally available, with
90 days' notice of withdrawal ([docs/compatibility.md](./docs/compatibility.md));
a critical fix may shorten that with a published reason and migration.

## If a release is compromised

The procedure is public so you can hold us to it:
[docs/runbooks/compromised-release.md](./docs/runbooks/compromised-release.md)
— freeze publication, rotate the affected access, deprecate the versions
(never unpublish), rebuild a clean replacement through the same gates, move
the dist-tags, publish an advisory. There is no remote deletion of local
files and no client kill switch.

## What the client will never do

Hooks are visible, provider-trusted and pinned to absolute paths on your
machine; no credential travels in a hook argument, plugin source or
transcript; the CLI holds no authority the service does not check again on
every request. If you find a case where any of that is not true, that is a
vulnerability — report it.
