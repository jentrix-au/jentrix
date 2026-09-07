# Runbook — migration failure on a customer machine

`jentrix plugin install <provider>` (also run by `jentrix setup`) migrates an
older registration to the current plugin package **two-phase**: stage the
package-backed plugin, pin its hooks, register or repoint the marketplace,
prove activation from the provider's own listing, and only then retire the
previous registration. Any failure restores the previous registration and
says so. This runbook is for when that last sentence is what the customer
is reading.

## First: `jentrix session doctor`

Ask for its output (it prints no secrets), or the file from `jentrix session
doctor --bundle`. The lines that matter:

| Line | Reading |
| --- | --- |
| `cli @jentrix/cli <v> — <source> (<path>)` | Which install is running: npm global, Homebrew, pnpm, npx cache, or a dev checkout. Two installs on one machine (e.g. Homebrew AND npm global) is the most common root cause: PATH picks one, the marketplace points at the other |
| `plugin <provider> … does not resolve from this install` | The plugin package is missing beside the CLI — a partial `npm i -g`, or a package manager that did not hoist. Fix: `npm i -g @jentrix/cli` again (it pulls the exact plugin pins) |
| `marketplace <provider> Official (stale copy): jentrix → <path>` | The provider's `jentrix` marketplace still points at an earlier installed copy of ours. Fix: `jentrix plugin install <provider>` (this is the migration; if it keeps failing, continue below) |
| `marketplace codex Official: jentrix → <path> (its root; Codex reported no source for the row)` | Healthy. Codex on Windows omits `marketplaceSource` for every local marketplace (it canonicalises the directory to a `\\?\` path and then cannot look it up), so the row was read by its `root` — which is this package |
| `marketplace <provider> User-managed: jentrix → <path>; not written by this CLI` / `… lists "jentrix" at a non-local source — marketplaceSource: {…}; not written by this CLI` | Someone registered `jentrix` from a checkout, a fork or a git source. The installer refuses to repoint it, by design. Fix, with the customer's consent: `<provider> plugin marketplace remove jentrix` then `jentrix plugin install <provider>` — or leave it if it is their fork ([forks](../forks.md)) |
| `marketplace <provider> Unregistered: … lists no "jentrix" marketplace (present: …)` | The provider has no `jentrix` row; the names it does have are listed. Fix: `jentrix plugin install <provider>` |
| `marketplace <provider> Unknown: … exited <code>: "…"` / `… exited 0 but printed no JSON catalog — first 200 bytes: "…"` | The provider's own listing failed, or printed something that is not its JSON catalog; the quoted bytes are the evidence (control characters shown escaped). Run `<provider> plugin marketplace list --json` by hand and read it; a dangling row of ours is removed and retried by the installer, a foreign broken row is relayed untouched |
| `hooks <provider> not pinned …` | The hooks still resolve through PATH only. Fix: `jentrix plugin install <provider>`; if it says "left as shipped: … not writable", the package directory is read-only (a Homebrew install run as another user, a locked-down npm prefix) |
| `hooks <provider> … the provider's cached copy DIFFERS` | The provider cached an older copy of the hooks; new sessions run the cache. Fix: `jentrix plugin install <provider>` then restart the provider; for Claude Code `claude plugin update jentrix@jentrix` also refreshes the cache |
| `telemetry … NOT recorded: …` | The hooks are not firing in this provider session. Usually the cached-copy case above, or hooks not yet trusted (Codex `/hooks`) |

## When `jentrix plugin install` restored the previous registration

The message names the phase that failed:

- **`PLUGIN_INSTALL_FAILED: activation not proven — … marketplace list --json shows "jentrix" at <a>, expected <b>`** — the provider accepted the add/repoint but its listing does not show it. Run the provider's listing by hand; if it shows `<b>` now, the listing was slow — retry the install. If it shows `<a>`, the provider refused the repoint silently (an older provider version, or a marketplace registered at project scope rather than user scope) — ask for the provider version and `<provider> plugin marketplace list --json`.
- **`PLUGIN_INSTALL_FAILED: \`codex plugin list --json\` did not report jentrix@jentrix as installed`** — the marketplace is right but the plugin is not installed from it. `codex plugin add jentrix@jentrix` by hand shows the reason.
- **`claude plugin install` relayed an error** — read it; the usual ones are a plugin already installed from a *different* marketplace with the same name (remove that first) and a version-cache conflict (`claude plugin update jentrix@jentrix`).

In every case the previous registration is active again; the customer's
sessions keep working on the old plugin while you look. Nothing is half
migrated.

## The four global layouts

Ownership recognition covers npm global, Homebrew `libexec`, pnpm global
(`.pnpm/@jentrix+…`) and the npx persistent root. A layout outside these —
a corporate wrapper that copies `node_modules` elsewhere, a symlinked
prefix — reads as **User-managed**, and the installer will not repoint it.
That is the safe outcome; the remedy is the explicit remove-then-install
above, and a note to us describing the layout so recognition can grow.

## Rollback

Rollback is reinstalling the previous published version — `npm i -g
@jentrix/cli@<previous>` then `jentrix plugin install <provider>` — never
editing the provider's config by hand. The previous plugin versions are
still on npm and the CLI pins them exactly.

## What to collect for an escalation

The doctor bundle, the exact `jentrix plugin install <provider>` output, the
provider's `plugin marketplace list --json` and `plugin list --json`, the
OS, and how the CLI was installed. Nothing else; in particular no transcript
and no token.
