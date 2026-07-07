// jsonc.ts — a tolerant JSON parser with per-key LINE tracking (§5.D). package.json in the
// wild is sometimes JSONC/JSON5 (comments, trailing commas), and bun.lock is JSONC; the
// dependency-fact extractor needs the 1-based line of each dependency KEY for permalinks.
// Pure, zero-dep, fail-fast on genuinely malformed input. Deliberately NOT full JSON5 — only
// the constructs npm manifests and bun lockfiles actually use: line/block comments, trailing
// commas, BOM, single-quoted strings, and unquoted identifier keys.

export class JsoncError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "JsoncError";
    this.line = line;
  }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface ParseResult {
  value: JsonValue;
  // JSON-pointer-ish path ("/dependencies/lodash", "/overrides/foo/bar") → 1-based line of the
  // KEY token. Object keys only; last writer wins for duplicate keys (mirrors JSON/JS).
  keyLines: Map<string, number>;
}

interface Parser {
  text: string;
  pos: number;
  line: number;
  keyLines: Map<string, number>;
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
// unquoted identifier keys (JSON5): a conservative subset — letters, digits, _, $, -.
const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$-]/.test(c);

function peek(p: Parser): string {
  return p.pos < p.text.length ? p.text[p.pos]! : "";
}

function advance(p: Parser): string {
  const c = p.text[p.pos]!;
  p.pos++;
  if (c === "\n") p.line++;
  return c;
}

// Skip whitespace AND comments (// line, /* block */). Newlines inside block comments are
// counted so line numbers stay accurate.
function skipTrivia(p: Parser): void {
  for (;;) {
    const c = peek(p);
    if (c === "") return;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance(p);
      continue;
    }
    if (c === "/" && p.text[p.pos + 1] === "/") {
      while (p.pos < p.text.length && peek(p) !== "\n") advance(p);
      continue;
    }
    if (c === "/" && p.text[p.pos + 1] === "*") {
      advance(p);
      advance(p);
      while (p.pos < p.text.length && !(peek(p) === "*" && p.text[p.pos + 1] === "/")) advance(p);
      if (p.pos >= p.text.length) throw new JsoncError("unterminated block comment", p.line);
      advance(p);
      advance(p);
      continue;
    }
    return;
  }
}

function parseString(p: Parser, quote: string): string {
  advance(p); // opening quote
  let out = "";
  for (;;) {
    if (p.pos >= p.text.length) throw new JsoncError("unterminated string", p.line);
    const c = advance(p);
    if (c === quote) return out;
    if (c === "\\") {
      if (p.pos >= p.text.length) throw new JsoncError("unterminated escape", p.line);
      const e = advance(p);
      switch (e) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "/": out += "/"; break;
        case "\\": out += "\\"; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break; // JSON5 single-quoted strings
        case "\n": break; // line continuation
        case "\r": if (peek(p) === "\n") advance(p); break;
        case "u": {
          const hex = p.text.slice(p.pos, p.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JsoncError("invalid \\u escape", p.line);
          out += String.fromCharCode(parseInt(hex, 16));
          for (let i = 0; i < 4; i++) advance(p);
          break;
        }
        // Fail closed: an unknown escape (\x, \q, …) is malformed input, not a literal char.
        default: throw new JsoncError(`invalid escape \\${e}`, p.line);
      }
      continue;
    }
    // Reject raw (unescaped) control characters incl. newlines — JSON forbids them in strings,
    // and a raw multi-line string is malformed manifest content, not a value to coerce.
    if (c.charCodeAt(0) < 0x20) throw new JsoncError("unescaped control character in string", p.line);
    out += c;
  }
}

// Strict JSON number grammar (fail closed): optional '-', an int part of '0' or [1-9][0-9]*
// (NO leading zeros, NO '+', NO bare '.'), an optional fraction with >=1 digit, an optional
// exponent with >=1 digit. Rejects 01, +1, 1., .5 — malformed manifest data must throw.
function parseNumber(p: Parser): number {
  const start = p.pos;
  if (peek(p) === "-") advance(p);
  if (peek(p) === "0") {
    advance(p);
  } else if (peek(p) >= "1" && peek(p) <= "9") {
    while (isDigit(peek(p))) advance(p);
  } else {
    throw new JsoncError("invalid number", p.line);
  }
  if (peek(p) === ".") {
    advance(p);
    if (!isDigit(peek(p))) throw new JsoncError("number fraction requires a digit", p.line);
    while (isDigit(peek(p))) advance(p);
  }
  if (peek(p) === "e" || peek(p) === "E") {
    advance(p);
    if (peek(p) === "+" || peek(p) === "-") advance(p);
    if (!isDigit(peek(p))) throw new JsoncError("number exponent requires a digit", p.line);
    while (isDigit(peek(p))) advance(p);
  }
  const raw = p.text.slice(start, p.pos);
  const n = Number(raw);
  // reject non-finite results too: a valid-grammar overflow like 1e9999 → Infinity is not a
  // representable JSON number, so fail closed rather than coerce it to +/-Infinity.
  if (!Number.isFinite(n)) throw new JsoncError(`non-finite number ${raw}`, p.line);
  return n;
}

function parseIdentifier(p: Parser): string {
  let out = "";
  while (isIdentPart(peek(p))) out += advance(p);
  return out;
}

function parseKey(p: Parser): string {
  const c = peek(p);
  if (c === '"' || c === "'") return parseString(p, c);
  if (isIdentStart(c)) return parseIdentifier(p);
  throw new JsoncError(`expected object key, got ${JSON.stringify(c) || "EOF"}`, p.line);
}

function parseValue(p: Parser, path: string): JsonValue {
  skipTrivia(p);
  const c = peek(p);
  if (c === "") throw new JsoncError("unexpected end of input", p.line);
  if (c === "{") return parseObject(p, path);
  if (c === "[") return parseArray(p, path);
  if (c === '"' || c === "'") return parseString(p, c);
  if (c === "-" || isDigit(c)) return parseNumber(p); // NO leading '+' or '.' (strict)
  // literals — only the three JSON keywords (NaN/Infinity are NOT JSON values; fail closed)
  const word = matchWord(p);
  if (word === "true") return true;
  if (word === "false") return false;
  if (word === "null") return null;
  throw new JsoncError(`unexpected token ${JSON.stringify(word || c)}`, p.line);
}

function matchWord(p: Parser): string {
  let out = "";
  while (/[A-Za-z]/.test(peek(p))) out += advance(p);
  return out;
}

function parseObject(p: Parser, path: string): { [k: string]: JsonValue } {
  advance(p); // {
  // NULL-prototype object: parsing UNTRUSTED manifests/lockfiles must not let a `__proto__`
  // (or `constructor`/`prototype`) KEY mutate the object's prototype. On a null-proto object,
  // `obj["__proto__"] = v` sets a normal own property instead of the prototype.
  const obj: { [k: string]: JsonValue } = Object.create(null);
  skipTrivia(p);
  if (peek(p) === "}") {
    advance(p);
    return obj;
  }
  for (;;) {
    skipTrivia(p);
    if (peek(p) === "}") {
      advance(p); // trailing comma before }
      return obj;
    }
    const keyLine = p.line;
    const key = parseKey(p);
    p.keyLines.set(`${path}/${escapePointer(key)}`, keyLine);
    skipTrivia(p);
    if (peek(p) !== ":") throw new JsoncError(`expected ':' after key ${JSON.stringify(key)}`, p.line);
    advance(p);
    obj[key] = parseValue(p, `${path}/${escapePointer(key)}`); // last writer wins on dup keys
    skipTrivia(p);
    const next = peek(p);
    if (next === ",") {
      advance(p);
      continue;
    }
    if (next === "}") {
      advance(p);
      return obj;
    }
    throw new JsoncError(`expected ',' or '}' in object, got ${JSON.stringify(next) || "EOF"}`, p.line);
  }
}

function parseArray(p: Parser, path: string): JsonValue[] {
  advance(p); // [
  const arr: JsonValue[] = [];
  skipTrivia(p);
  if (peek(p) === "]") {
    advance(p);
    return arr;
  }
  for (;;) {
    skipTrivia(p);
    if (peek(p) === "]") {
      advance(p); // trailing comma before ]
      return arr;
    }
    const idx = arr.length;
    arr.push(parseValue(p, `${path}/${idx}`));
    skipTrivia(p);
    const next = peek(p);
    if (next === ",") {
      advance(p);
      continue;
    }
    if (next === "]") {
      advance(p);
      return arr;
    }
    throw new JsoncError(`expected ',' or ']' in array, got ${JSON.stringify(next) || "EOF"}`, p.line);
  }
}

// JSON-pointer escaping: ~ → ~0, / → ~1 (so a dependency key containing '/' like a scoped
// name @scope/name yields an unambiguous, reversible pointer segment).
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parseJsonc(text: string): ParseResult {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM
  const p: Parser = { text: stripped, pos: 0, line: 1, keyLines: new Map() };
  // account for the stripped BOM: line counting starts at 1 regardless.
  const value = parseValue(p, "");
  skipTrivia(p);
  if (p.pos < p.text.length) throw new JsoncError(`trailing content after JSON value`, p.line);
  return { value, keyLines: p.keyLines };
}

// Convenience: parse and require an object root (package.json / bun.lock are always objects).
export function parseJsoncObject(text: string): { value: { [k: string]: JsonValue }; keyLines: Map<string, number> } {
  const result = parseJsonc(text);
  if (result.value === null || typeof result.value !== "object" || Array.isArray(result.value))
    throw new JsoncError("expected a JSON object at the document root", 1);
  return { value: result.value, keyLines: result.keyLines };
}
