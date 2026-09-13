# Impact records (plugin-sync G02)

Every change that touches a shared path, an adapter, a plugin package, the
workflow sources or the registry lands with ONE JSON record in this directory
(`YYYY-MM-DD-<issue>-<slug>.json`). `pnpm check:plugin-sync` refuses a
candidate whose merge-base→candidate diff touches those paths without a record
that was added or modified in the same diff, and refuses any record that does
not give every official host — enrolled AND planned — an explicit disposition.

```json
{
  "recordVersion": 1,
  "id": "2026-09-12-jen-533-sync-guard",
  "issue": "JEN-533",
  "title": "one line",
  "behaviors": ["P16", "R01"],
  "base": { "revision": "<merge-base sha>" },
  "candidate": { "revision": "working-tree | <sha>" },
  "paths": ["src/session-host/session-bridge.ts"],
  "hosts": {
    "claude":   { "disposition": "shared-fix-applied",  "evidence": ["test/x.test.ts"] },
    "codex":    { "disposition": "adapter-fix-applied", "evidence": ["test/y.test.ts"] },
    "opencode": { "disposition": "planned", "plannedIn": "JEN-537" },
    "pi":       { "disposition": "planned", "plannedIn": "JEN-537" }
  }
}
```

Dispositions for an ENROLLED host: `shared-fix-applied` (the change lives in
shared code that every enrolled adapter runs), `adapter-fix-applied` (the
host's own adapter or package changed), `verified-unaffected` (requires
`evidence` naming an executable test or check AND a `rationale`), or
`not-applicable` (a demonstrably absent native capability — requires
`applicability` with `host`, `version`, `source` and `reviewedBy`). A PLANNED
host takes `planned` with `plannedIn`. A blank, missing or unknown host is a
failure; so is `verified-unaffected` with no evidence — a label is not a test.
