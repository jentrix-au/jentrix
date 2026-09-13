# S0b native fixtures (M2, JEN-537)

Sanitised probe logs recorded on the REAL hosts — OpenCode 1.18.9 and Pi
0.85.1 — in isolated profiles with a scripted local model, by the probes in
task-manager `reports/plugin-sync-2026-09-12/fixtures/s0b/` (provenance,
checksums and the observations they support are in
`reports/plugin-sync-2026-09-12/m2-s0b-native-proof.md` there). Each line is
one hook or event the host delivered to the probe, in order, with the fields
the plugins consume. `test/plugin-runtime-opencode.test.ts` and
`test/plugin-runtime-pi.test.ts` replay them through the plugin code and
assert the ledger, the mapped events and the receipts; the mapper tests pin
the token figures directly. Paths are replaced by `<m2>`, `<home>`,
`<scratchpad>`, `<m2-dashed>`, `<sandbox>`. Never regenerate by hand: re-run
the probes on the pinned host versions.
