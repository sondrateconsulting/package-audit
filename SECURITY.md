# Security policy

## Supported versions

This project ships from a rolling `main` branch. The tip of `main` is the supported version; there are no maintained release branches and no backported fixes. If you are running an older checkout, please update to current `main` before reporting.

## Reporting a vulnerability

Report vulnerabilities privately by email to **securityatsondrate.0ccgx@passmail.com**. Please do not open public issues or pull requests for suspected vulnerabilities — a public report can put every operator running the tool at risk before a fix exists.

Include what you can: a description of the issue, steps or code to reproduce it, and your assessment of impact. You will receive an acknowledgment within 7 days.

## Scope

This tool is designed to be pointed at GitHub organizations its operator does not own, and it is read-only by construction — an argv-allowlist on every shell-out, a blanket package-manager ban, write containment to `./data`, `./output`, and `pkg-audit-*` temp dirs, and registry tarball hygiene (see the trust section of the [README](README.md) and the normative spec in [PROMPT.md](PROMPT.md)).

Reports demonstrating that the read-only guarantee can be violated — any path by which a run could write to, mutate, or execute code from a scanned repository, organization, or registry artifact — are explicitly in scope and especially welcome. So are the quieter failure modes: credential leakage into logs or the database beyond what the README documents, or scope widening beyond the configured organizations.
