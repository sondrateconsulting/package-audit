# Security policy

## Supported versions

This project ships from a rolling `main` branch. The tip of `main` is the supported version; there are no maintained release branches and no backported fixes. If you are running an older checkout, please update to current `main` before reporting.

## Reporting a vulnerability

**Please report privately, and please do not open a public issue, pull request, or discussion for a suspected vulnerability.** Coordinated disclosure — the model set out in ISO/IEC 29147:2018 and the CERT Guide to Coordinated Vulnerability Disclosure — reduces the risk to the operators running this tool: reporting privately first gives the maintainers an opportunity to prepare a fix before the details are public, rather than exposing every operator the moment a public report appears.

Use whichever private channel you prefer. You're welcome to report under a pseudonym or from an anonymous address:

1. **GitHub private vulnerability reporting (preferred).** Use the **"Report a vulnerability"** button on this repository's advisories page ([direct link](https://github.com/sondrateconsulting/package-audit/security/advisories/new)). It keeps the report and the whole coordination thread confidential between you and the maintainers, and gives us a structured place to develop and publish the fix. If you don't see that option, use email.
2. **Email.** Write to **securityatsondrate.0ccgx@passmail.com**. Keep proof-of-concept material to the minimum needed to demonstrate the issue, don't include live credentials or third-party data, and ask for a PGP key first if you need to send anything sensitive.

(RFC 9116 defines the machine-readable `security.txt` convention for advertising a disclosure contact; this policy is the project's canonical contact until the tool has a hosted origin to serve one from.)

### What to include

Following the OWASP Vulnerability Disclosure Cheat Sheet, a good report describes the issue in clear, plain terms, gives us enough to reproduce it, and states the impact you believe it has:

- a description of the issue and its security impact, written so the reader doesn't have to already know what you found;
- steps to reproduce, a proof-of-concept, or other supporting evidence.

For this project specifically, it also helps to include:

- the affected commit SHA (`git rev-parse HEAD`), plus your OS and your Bun, `gh`, `git`, and `tar` versions;
- optionally, your own severity assessment — a CVSS v4.0 vector (FIRST) is welcome but never required.

### What to expect

Our handling follows the vendor process described in ISO/IEC 30111:2019 (vulnerability handling processes); the specific timelines below are this project's own commitments, not requirements of that standard:

- **Acknowledgment within 7 days** that your report reached a human.
- An initial assessment — accepted, needs-more-info, or declined-with-reasoning — as triage completes, then honest status updates through remediation. This is a small project, so timelines are best-effort rather than a contractual SLA.
- **Coordinated disclosure.** We aim to land a fix on current `main` and publish a GitHub Security Advisory — crediting you unless you'd rather stay anonymous, and requesting a CVE where one is warranted — before or together with any public detail, so please hold public disclosure until then. If a report stalls, we'd rather agree a disclosure date with you than wait indefinitely: the commonly cited industry range is 45–90 days from the initial report (per the CERT Guide), and we treat 90 days as a backstop to beat by agreement, not a deadline to run down.

## Safe harbor

We consider security research on this project, carried out in good faith under this policy, to be authorized — and we will not pursue or support legal action against you for it, including under applicable anti-hacking or anti-circumvention law or this project's own terms. We'll treat a genuine, good-faith effort to comply as authorized even if you stray slightly from these guidelines by accident, and if a third party brings action against you over research that followed this policy, we'll make it known that your work was authorized by us.

"Good faith" means you make a reasonable effort to avoid privacy violations, data destruction, and interruption of service; you access or modify only the minimum data needed to demonstrate the issue; and if you come across data that isn't yours, you stop, don't save or share it, and tell us.

This authorization covers **only package-audit's own code and this repository.** It does **not** authorize testing against — or pointing the tool at — any system you are not otherwise permitted to access, including GitHub itself, npm or other package registries, and any GitHub organization or repository you scan with the tool. We can only speak for ourselves: this safe harbor binds this project alone and cannot waive the rights of GitHub, any registry, or any third party whose systems your testing might touch. Denial-of-service, social engineering, physical attacks, and testing of third-party systems are out of scope and unauthorized.

This policy draws on the safe-harbor approach recommended in the U.S. CISA Vulnerability Disclosure Policy Template (implementing Binding Operational Directive 20-01) and the U.S. Department of Justice's *Framework for a Vulnerability Disclosure Program for Online Systems*. If you're unsure whether something is authorized, ask first through one of the channels above.

## Scope

This tool is designed to be pointed at GitHub organizations its operator does not own, and it is read-only by construction — an argv-allowlist on every shell-out, a blanket package-manager ban, write containment to `./data`, `./output`, and `pkg-audit-*` temp dirs, and registry tarball hygiene (see the trust section of the [README](README.md) and the normative spec in [PROMPT.md](PROMPT.md)).

Reports demonstrating that the read-only guarantee can be violated — any path by which a run could write to, mutate, or execute code from a scanned repository, organization, or registry artifact — are explicitly in scope and especially welcome. So are the quieter failure modes: credential leakage into logs or the database beyond what the README documents, or scope widening beyond the configured organizations.

## References

The practices above follow current, publicly available disclosure standards (accurate as of 2026-07-11):

- ISO/IEC 29147:2018 — *Information technology — Security techniques — Vulnerability disclosure* — <https://www.iso.org/standard/72311.html>
- ISO/IEC 30111:2019 — *Information technology — Security techniques — Vulnerability handling processes* — <https://www.iso.org/standard/69725.html>
- The CERT Guide to Coordinated Vulnerability Disclosure (CERT/CC, Carnegie Mellon Software Engineering Institute) — <https://certcc.github.io/CERT-Guide-to-CVD/>
- OWASP Vulnerability Disclosure Cheat Sheet — <https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html>
- RFC 9116 — *A File Format to Aid in Security Vulnerability Disclosure* (`security.txt`) — <https://www.rfc-editor.org/info/rfc9116/>
- CVSS v4.0 (FIRST) — <https://www.first.org/cvss/v4.0/>
- GitHub — *Privately reporting a security vulnerability* — <https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately>
- disclose.io — safe-harbor terms and policy templates — <https://disclose.io/>
- U.S. CISA — *Vulnerability Disclosure Policy Template* — <https://www.cisa.gov/vulnerability-disclosure-policy-template>
- U.S. DOJ (Criminal Division / CCIPS) — *A Framework for a Vulnerability Disclosure Program for Online Systems* — <https://www.justice.gov/media/905211/dl?inline=>
