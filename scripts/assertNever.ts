// assertNever.ts — the compile-time exhaustiveness backstop for a switch over a closed union.
//
// A DEPENDENCY-FREE leaf (imports nothing) so any layer — the SQLite writer, the pure HTML renderer,
// the report builder — can use it without pulling in another layer's stack. The `never` parameter IS
// the mechanism: the call typechecks ONLY while every union member is handled upstream, so ADDING a
// member turns the call site into a build error instead of a silent fall-through. The throw is the
// runtime half — structurally unreachable — and a plain Error (not a domain error class) because
// reaching it is a TOOL BUG with no operator remediation to offer.
export function assertNever(x: never, what: string): never {
  throw new Error(`internal: unhandled ${what}: ${JSON.stringify(x)}`);
}
