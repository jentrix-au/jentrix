# Trademarks and naming

"Jentrix" and the Jentrix logo are trademarks of Jentrix. The MIT licence
covers the code in this repository; it does not grant trademark rights. This
policy exists so that forks and integrations are easy to name correctly and
impossible to mistake for the official client.

## Reserved identities

These names identify the official client and are reserved to Jentrix
(open-client PRD §4):

- the npm packages `@jentrix/cli`, `@jentrix/plugin-claude`,
  `@jentrix/plugin-codex` — and, by extension, any package under the
  `@jentrix` scope;
- the provider **marketplace and plugin name `jentrix`** in Claude Code and
  Codex (and its legacy name `stacks`);
- the command names `jentrix`, `stacks` and `jentrix-session-host` on the
  PATH.

Only artifacts published by Jentrix through this repository's release
workflow carry these names. Diagnostics (`jentrix session doctor`) label a
marketplace registration that was not written by the official CLI as
**user-managed**, and official support stops at the API boundary for it.

## Naming a fork or an extension

You may copy, fork, modify and privately or publicly distribute the client
and the plugins under the MIT licence. When you do:

- **Use a name you control**, for example `acme-jentrix`,
  `@acme/jentrix-plugin`, or "Acme workflow for Jentrix". Do not publish a
  package, marketplace or plugin under a reserved identity, and do not use
  the `@jentrix` scope.
- **You may say "for Jentrix"**, "works with Jentrix", "integrates with
  Jentrix", "based on the Jentrix open client", or "a fork of
  `@jentrix/cli`" — factual statements of compatibility and origin.
- **You may not say "official Jentrix"**, "Jentrix-verified",
  "Jentrix-certified", or otherwise imply that Jentrix built, endorses,
  supports or vouches for the fork, and you may not present modified hooks or
  a modified session host as producing Jentrix-verified evidence.
- **Keep the licence and notices** (`LICENSE`, `NOTICE`) with any
  redistribution, per the MIT terms.

## Logo

The logo may be used only to refer to Jentrix itself (for instance in a
"works with" line), unmodified, and never as the primary mark of a fork or as
a plugin icon.

## Questions

If a name or description is not obviously covered here, open an issue titled
"Naming question" and describe what you want to call the thing; the answer is
usually yes with a small adjustment.
