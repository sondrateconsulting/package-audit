import { describe, expect, test } from "bun:test";
import { buildBatchRefsQuery } from "./graphqlBatch.ts";

// ADR-0002 "The design, concretely" — batch shape. The builder is PURE and lands in Stage P so
// the Confirmation-1 probe prices the query that ships (plan §4/§5 P1): the probe arm and the
// production arm are the same document modulo the rateLimit rider, BY CONSTRUCTION, and the
// rider-equivalence test below pins exactly that.

const repos = (n: number): Array<{ owner: string; name: string }> =>
  Array.from({ length: n }, (_, i) => ({ owner: `owner-${i}`, name: `repo-${i}` }));

// the solo listBranchHeads page shape (github.ts) minus the after-cursor argument: page 1 of a
// batched alias never carries a cursor, and the node/pageInfo shape must be the solo one so the
// existing validation battery transfers unchanged (ADR Confirmation 6).
const REFS_PAGE1_SELECTION =
  "refs(refPrefix:\"refs/heads/\",first:100){pageInfo{hasNextPage endCursor}nodes{name target{...on Commit{oid committedDate tree{oid}}}}}";

describe("buildBatchRefsQuery — batch shape", () => {
  test("one aliased repository selection per repo, rN:repository(owner:$oN,name:$nN)", () => {
    const b = buildBatchRefsQuery(repos(3), {});
    expect(b.aliasCount).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(b.query).toContain(`r${i}:repository(owner:$o${i},name:$n${i})`);
    }
    // no extra aliases beyond the requested B
    expect(b.query).not.toContain("r3:repository");
  });

  test("every alias selects identity re-assertion + default + the solo page-1 refs shape", () => {
    const b = buildBatchRefsQuery(repos(2), {});
    const aliasBody = `{nameWithOwner defaultBranchRef{name}${REFS_PAGE1_SELECTION}}`;
    for (let i = 0; i < 2; i++) {
      expect(b.query).toContain(`r${i}:repository(owner:$o${i},name:$n${i})${aliasBody}`);
    }
    // page 1 by construction: no cursor argument anywhere in the document
    expect(b.query).not.toContain("after:");
  });

  test("variables-only binding: 2B declared variables, identities in fields, never inline", () => {
    // isCanonicalIdentity admits GraphQL metacharacters (quotes, braces) on purpose — the
    // batched query must bind identities as variables so no identity byte reaches the document
    const hostile = [
      { owner: 'ow"ner{a', name: 'na}me"b' },
      { owner: "plain", name: "repo" },
    ];
    const b = buildBatchRefsQuery(hostile, {});
    for (let i = 0; i < hostile.length; i++) {
      expect(b.query).toContain(`$o${i}:String!`);
      expect(b.query).toContain(`$n${i}:String!`);
      expect(b.fields[`o${i}`]).toBe(hostile[i]!.owner);
      expect(b.fields[`n${i}`]).toBe(hostile[i]!.name);
    }
    expect(Object.keys(b.fields).length).toBe(2 * hostile.length);
    expect(b.query).not.toContain(hostile[0]!.owner);
    expect(b.query).not.toContain(hostile[0]!.name);
  });

  test("no variable may be named 'query' (the gh argv field collision guard by construction)", () => {
    const b = buildBatchRefsQuery(repos(30), {});
    expect(Object.keys(b.fields)).not.toContain("query");
  });

  test("expected[] echoes alias→identity pairing in kept order (the router's contract)", () => {
    const input = [
      { owner: "acme", name: "alpha" },
      { owner: "acme", name: "beta" },
    ];
    const b = buildBatchRefsQuery(input, {});
    expect(b.expected).toEqual([
      { alias: "r0", owner: "acme", name: "alpha" },
      { alias: "r1", owner: "acme", name: "beta" },
    ]);
  });
});

describe("buildBatchRefsQuery — rateLimit rider equivalence (the probe prices the shipped query)", () => {
  test("rider-on differs from rider-off by exactly the rider field, nothing else", () => {
    const on = buildBatchRefsQuery(repos(5), { rateLimitRider: "rateLimit{cost}" });
    const off = buildBatchRefsQuery(repos(5), {});
    // the rider rides the query root, appended before the closing brace — byte-for-byte
    expect(on.query).toBe(`${off.query.slice(0, -1)} rateLimit{cost}}`);
    expect(on.fields).toEqual(off.fields);
    expect(on.expected).toEqual(off.expected);
  });

  test("an empty rider string is the production shape (no rider text, no stray whitespace)", () => {
    const explicit = buildBatchRefsQuery(repos(2), { rateLimitRider: "" });
    const absent = buildBatchRefsQuery(repos(2), {});
    expect(explicit.query).toBe(absent.query);
    expect(absent.query).not.toContain("rateLimit");
  });
});

describe("buildBatchRefsQuery — input validation (fail fast, fail closed)", () => {
  test("an empty repo list is rejected", () => {
    expect(() => buildBatchRefsQuery([], {})).toThrow(/at least one repository/i);
  });

  test("a duplicate (owner,name) pair is rejected case-insensitively (GitHub identities are)", () => {
    expect(() =>
      buildBatchRefsQuery(
        [
          { owner: "Acme", name: "Widget" },
          { owner: "acme", name: "widget" },
        ],
        {},
      ),
    ).toThrow(/duplicate/i);
  });

  test("an empty owner or name segment is rejected", () => {
    expect(() => buildBatchRefsQuery([{ owner: "", name: "x" }], {})).toThrow(/owner/i);
    expect(() => buildBatchRefsQuery([{ owner: "x", name: "" }], {})).toThrow(/name/i);
  });
});

describe("buildBatchRefsQuery — argv accounting (the admission input)", () => {
  test("queryBytes and argvBytes mirror the gh raw-field argv shape", () => {
    const input = repos(2);
    const b = buildBatchRefsQuery(input, { rateLimitRider: "rateLimit{cost}" });
    expect(b.queryBytes).toBe(Buffer.byteLength(b.query, "utf8"));
    let argvBytes = Buffer.byteLength(`query=${b.query}`, "utf8") + 2 * "-f".length;
    for (const [k, v] of Object.entries(b.fields)) argvBytes += Buffer.byteLength(`${k}=${v}`, "utf8") + "-f".length;
    expect(b.argvBytes).toBe(argvBytes);
  });
});
