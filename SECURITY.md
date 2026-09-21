# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately through
GitHub's [security advisory
form](https://github.com/jonit-dev/lean-pi/security/advisories/new), or by email
to <admin@coldstartlabs.ca> if you prefer not to use GitHub.

Include what you need to make the report reproducible: the version or commit,
the configuration, the command or session that triggers it, and the impact.
Expect an acknowledgement within a few days. This is a small project with no
paid on-call, so a fix may take longer than the reply; you will be told which it
is. Credit in the fix's release notes if you want it.

## Supported versions

The `main` branch is the supported version. There are no maintenance branches
and no backports to older tags; security fixes land on `main` and in the next
release.

## What is in scope

LeanPi runs an agent that reads and writes files, executes shell commands and
speaks to model providers. The boundaries that are supposed to hold:

- **Tool authorization.** Every tool call resolves `allow` / `ask` / `deny`
  through the permission engine, and that resolution must be a deterministic
  function of configuration, never a model judgement. A path that reaches a
  tool without that decision — including one reachable through an MCP server, a
  subagent, or a `--safety` level that does not say what it claims — is a
  vulnerability.
- **Trust boundaries.** Untrusted project configuration (a checked-out
  `leanpi.config.yaml`, `.leanpi/`, project-local skills) must be able to tighten
  policy and never to grant itself a capability. A project file that escalates
  is a vulnerability.
- **Credentials.** Provider and JEV keys are read from the environment or from
  `~/.config/leanpi/credentials.json` (mode 0600), are never written into a
  config file, and must never reach a log, a telemetry record, a benchmark
  artifact or a provider request that did not need them. Any path that leaks one
  is a vulnerability.
- **Bundled content integrity.** The vendored skill pack and the static
  instruction prefix are hash-locked and must hard-fail on a mismatch rather
  than load a mutated file.
- **Code execution in the harness itself.** Command construction, path
  handling, and anything that turns model output into a process or a file
  write.

## What is not

- The consequences of a permission scope you chose. `--safety low`, or
  `/permissions set shell allow`, mean what they say.
- Prompt injection that stays inside the scopes you granted, unless it crosses
  one of the boundaries above.
- Cost, quota or rate-limit exhaustion.
- Denial of service in a provider's API, or vendor-side outages.
- Vulnerabilities in a model provider, a vendor CLI (`claude`, `codex`,
  `opencode`), or in Pi and its dependencies — report those upstream. If
  LeanPi's handling of one of them is what makes it exploitable here, that part
  is in scope.
