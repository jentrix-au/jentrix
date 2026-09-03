---
description: Show the connected Jentrix session for this work (capture health included)
allowed-tools: Bash(jentrix session:*)
---
<!-- Source of truth: cli/plugins. Shipped verbatim in the npm package. -->

Run `jentrix session status` with the Bash tool (append the session id if the
user gave one) and relay the output verbatim, including any capture-pending
warning.
