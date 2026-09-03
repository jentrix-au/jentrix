# Runbooks

Operational procedures for the open client, public so that customers can
read what happens and hold the maintainers to it.

| Runbook | When |
| --- | --- |
| [Contract digest mismatch](./contract-digest-mismatch.md) | `jentrix session doctor` reports drift or a refusal at the contract line, or `adopt-contract` refuses with `DIGEST_MISMATCH` |
| [Publish failure or partial promotion](./publish-failure.md) | A `cli-v*` run went red, a candidate is missing from npm, or `latest` points at a mixed set |
| [Compromised release](./compromised-release.md) | A published version is suspected or known to be malicious or built from a compromised pipeline |
| [Migration failure on a customer machine](./migration-failure.md) | `jentrix plugin install` restored the previous registration, refused a marketplace, or a session stopped recording after an upgrade |
