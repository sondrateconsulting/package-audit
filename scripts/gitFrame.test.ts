import { expect, test, describe } from "bun:test";
import {
  gitBlobOid, seamDecode, oidFormatOf, encodeOidRequest, GitFrameError,
  BatchFrameParser, parseLsTreeZ, OID_LENGTH,
} from "./gitFrame.ts";

// The ported parser bodies (BatchFrameParser / parseLsTreeZ / ByteRing) keep their full
// original coverage via benchFrame.test.ts, which now exercises them through the bench shim.
// THIS file covers the surface production ADDED at adoption: the blob self-verification
// hasher, the seam decode, format derivation, and the OID-only stdin writer's validation
// core (ADR-0001 Confirmation checks 2 and 3's pre-decode hash).

const enc = new TextEncoder();

describe("gitBlobOid — canonical `blob <len>\\0<body>` hashing (check 3 self-verification)", () => {
  // Ground truths computed independently (python hashlib) and cross-checked against
  // `git hash-object --stdin` for the sha1 vectors.
  test("sha1 of the empty blob is git's canonical empty-blob oid", () =>
    expect(gitBlobOid(new Uint8Array(0), "sha1")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"));
  test("sha1 of `hello world\\n` matches git hash-object", () =>
    expect(gitBlobOid(enc.encode("hello world\n"), "sha1")).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad"));
  test("sha256 of the empty blob matches git's sha256 object format", () =>
    expect(gitBlobOid(new Uint8Array(0), "sha256")).toBe("473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"));
  test("sha256 of `hello world\\n`", () =>
    expect(gitBlobOid(enc.encode("hello world\n"), "sha256")).toBe("0bd69098bd9b9cc5934a610ab65da429b525361147faa7b5b922919e9a23143d"));
  test("the header length is the BYTE length, not a character count (independent non-ASCII pin)", () => {
    // "é" is 2 UTF-8 bytes, so the canonical object is `blob 2\0é` — pinned to independently
    // computed hashes (python hashlib, cross-checked). A character-count header (`blob 1\0`)
    // yields sha1 4abd0d2592c882e7eab96ae8f47f274a56d52042 instead, so this pin genuinely
    // discriminates the bug (santa round-1: the earlier form only compared the function to
    // itself).
    const body = enc.encode("é");
    expect(body.byteLength).toBe(2);
    expect(gitBlobOid(body, "sha1")).toBe("4b04fff51468d8ab5201ab02b725dc477bc7cb45");
    expect(gitBlobOid(body, "sha256")).toBe("8c5d37839f0a8720802a9c1b85aa1958752d66c980e6920c56076707f382f18f");
  });
});

describe("seamDecode — the deliberate UTF-8-with-replacement seam decode", () => {
  test("valid UTF-8 passes through byte-exactly", () =>
    expect(seamDecode(enc.encode("héllo\n"))).toBe("héllo\n"));
  test("invalid sequences become replacement characters, never a throw", () =>
    expect(seamDecode(new Uint8Array([0x68, 0xc0, 0x80, 0x69]))).toBe("h��i"));
  test("empty input decodes to the empty string", () => expect(seamDecode(new Uint8Array(0))).toBe(""));
});

describe("oidFormatOf — repository object-format derivation from the pinned head oid", () => {
  test("40 lowercase hex → sha1", () => expect(oidFormatOf("a".repeat(40))).toBe("sha1"));
  test("64 lowercase hex → sha256", () => expect(oidFormatOf("0123456789abcdef".repeat(4))).toBe("sha256"));
  test("uppercase hex → null (canonical oids are lowercase)", () => expect(oidFormatOf("A".repeat(40))).toBeNull());
  test("wrong length → null", () => expect(oidFormatOf("a".repeat(39))).toBeNull());
  test("non-hex at full length → null", () => expect(oidFormatOf("g".repeat(40))).toBeNull());
  test("empty → null", () => expect(oidFormatOf("")).toBeNull());
});

describe("encodeOidRequest — the OID-only stdin writer's validation core (check 2)", () => {
  const SHA1 = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
  test("a full sha1 oid encodes to exactly `<oid>\\n` bytes", () => {
    const bytes = encodeOidRequest(SHA1, "sha1");
    expect(new TextDecoder().decode(bytes)).toBe(`${SHA1}\n`);
  });
  test("a full sha256 oid encodes under the sha256 format", () => {
    const oid = "0bd69098bd9b9cc5934a610ab65da429b525361147faa7b5b922919e9a23143d";
    expect(new TextDecoder().decode(encodeOidRequest(oid, "sha256"))).toBe(`${oid}\n`);
  });
  const reject = (label: string, oid: string, format: "sha1" | "sha256" = "sha1") =>
    test(`rejects ${label}`, () => expect(() => encodeOidRequest(oid, format)).toThrow(GitFrameError));
  reject("a truncated oid (39 hex)", "a".repeat(39));
  reject("an overlong oid (41 hex)", "a".repeat(41));
  reject("uppercase hex", "A".repeat(40));
  reject("non-hex characters at full length", "xyz" + "a".repeat(37));
  reject("the empty string", "");
  reject("a path where an oid should be", "../../etc/passwd" + "a".repeat(24));
  reject("an embedded newline (would smuggle a second request line)", "a".repeat(39) + "\n");
  reject("leading whitespace", " " + "a".repeat(39));
  reject("a sha256-length oid under the sha1 format (mixed formats)", "a".repeat(64), "sha1");
  reject("a sha1-length oid under the sha256 format (mixed formats)", "a".repeat(40), "sha256");
  reject("a rev expression", "HEAD");
  reject("an oid with a rev suffix", "a".repeat(40) + "^{tree}");
});

describe("production re-export coherence", () => {
  test("OID_LENGTH matches both formats", () => expect(OID_LENGTH).toEqual({ sha1: 40, sha256: 64 }));
  test("the ported parser classes are live on the production surface", () => {
    expect(typeof BatchFrameParser).toBe("function");
    expect(typeof parseLsTreeZ).toBe("function");
  });
});
