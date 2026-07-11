// packageName.ts — strict, fail-closed npm package-name validation (zero-dep, pure).
//
// SECURITY (§5.E): a package name flows into the packument URL and (via dist.tarball) the fetch
// layer, where a bearer token is attached to ANY URL whose origin equals the registry origin. A
// hostile name such as `@x\..\..\admin?x=1` (REAL backslashes) or `%2e%2e/%2e%2e/admin?x=1`
// normalizes through WHATWG `new URL` to a DIFFERENT same-origin path/query — leaking the auth
// token to an attacker-chosen target. Package names were otherwise validated for non-emptiness
// only, so this is the gate that closes that path.
//
// This is INTENTIONALLY a strict SUBSET of historically-valid npm names: exotic legacy names
// using old-valid punctuation (`!`, `(`, `)`, `*`) or a leading `.`/`_` are deliberately
// REJECTED — fail-closed is acceptable for an audit tool, since a name that cannot be safely
// URL-embedded is not worth auditing. Uppercase IS allowed (e.g. `JSONStream`), matching real
// published names.

export const MAX_PACKAGE_NAME_LEN = 214;

// One name segment: an alphanumeric start, then only the URL-safe unreserved subset that a
// `new URL` pathname round-trips unchanged. Excludes `/`, `@`, `%`, whitespace, and every other
// metacharacter, so no segment can smuggle a path separator, traversal, query, or fragment.
const SEG = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

// Returns true only for a name that is safe to embed in a registry URL. Guards type/length at
// the boundary (external data is never trusted), then splits a scoped name into scope + rest and
// requires BOTH to be a single valid segment — a `rest` that still contains a `/` fails SEG, so a
// multi-slash name like `@a/b/c` is rejected.
export function isValidPackageName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_PACKAGE_NAME_LEN) return false;
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash < 0) return false; // a scoped name MUST contain exactly one "/"
    const scope = name.slice(1, slash); // EXCLUDE the leading "@" — SEG would reject a scope that still had it
    const rest = name.slice(slash + 1);
    return SEG.test(scope) && SEG.test(rest);
  }
  return SEG.test(name);
}
