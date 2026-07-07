// yamlLite.ts — a MINIMAL, fail-closed YAML-subset parser with per-node LINE tracking, just
// enough for the block-mapping shapes pnpm-lock.yaml (v5/v6/v9) and yarn-berry yarn.lock emit
// (§5.D). It is NOT a general YAML parser: it fails closed (throws) on anchors/aliases, merge
// keys, tags, block scalars (|, >), tabs-as-indent, and flow collections other than empty
// {}/[]. A parse failure means "skip this lockfile," never "fail the run" — callers catch.

export class YamlLiteError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "YamlLiteError";
    this.line = line;
  }
}

// A scalar carries its source line; a map/seq carries the line of its first key/item. Maps
// preserve insertion order and expose each entry's key line for permalink spans.
export type YamlNode = YamlScalar | YamlMap | YamlSeq;
export interface YamlScalar {
  kind: "scalar";
  value: string;
  line: number;
}
export interface YamlMapEntry {
  key: string;
  keyLine: number;
  value: YamlNode;
}
export interface YamlMap {
  kind: "map";
  entries: YamlMapEntry[];
  line: number;
}
export interface YamlSeq {
  kind: "seq";
  items: YamlNode[];
  line: number;
}

interface Line {
  raw: string;
  indent: number; // count of leading SPACES (tabs rejected)
  content: string; // after indent, before trailing comment
  lineNo: number; // 1-based
  blank: boolean;
}

// Split a document into significant lines, dropping blanks and whole-line comments, rejecting
// constructs the subset does not support. Comments and indentation are computed comment-safe.
function scan(text: string): Line[] {
  const out: Line[] = [];
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.replace(/\r$/, "");
    const lineNo = i + 1;
    if (raw.trim() === "") continue;
    if (/^\s*#/.test(raw)) continue; // whole-line comment
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent++;
    if (raw[indent] === "\t") throw new YamlLiteError("tab indentation is not supported", lineNo);
    const afterIndent = raw.slice(indent);
    const content = stripTrailingComment(afterIndent);
    // Reject unsupported YAML features up front (fail closed).
    if (/(^|\s)&\S/.test(content) || /(^|\s)\*\S/.test(content))
      throw new YamlLiteError("anchors/aliases are not supported", lineNo);
    if (/^<<\s*:/.test(content)) throw new YamlLiteError("merge keys are not supported", lineNo);
    if (/(^|\s)!!?\S/.test(content)) throw new YamlLiteError("tags are not supported", lineNo);
    if (/:\s*[|>][+-]?\s*$/.test(content)) throw new YamlLiteError("block scalars are not supported", lineNo);
    out.push({ raw, indent, content, lineNo, blank: false });
  }
  return out;
}

// Strip a trailing `# comment`, but ONLY when the '#' is outside quotes and preceded by
// whitespace or at start (YAML requires a space before an inline comment).
function stripTrailingComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (inDouble) {
      if (c === "\\") i++;
      else if (c === '"') inDouble = false;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i).replace(/\s+$/, "");
    }
  }
  return s.replace(/\s+$/, "");
}

// Unquote a scalar token. Plain scalars are returned verbatim (trimmed). Quoted scalars have
// their quotes removed and minimal escapes resolved.
function unquoteScalar(token: string, line: number): string {
  const t = token.trim();
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1).replace(/''/g, "'"); // YAML single-quote escaping
  }
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    let out = "";
    const body = t.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c === "\\" && i + 1 < body.length) {
        const e = body[++i]!;
        out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
      } else {
        out += c;
      }
    }
    return out;
  }
  if (t === "{}" || t === "[]") return "";
  if ((t.startsWith("{") || t.startsWith("[")) && t !== "{}" && t !== "[]")
    throw new YamlLiteError("non-empty flow collections are not supported", line);
  return t;
}

// Split a "key: value" mapping line into its key token and the remainder value text, honoring
// quotes around the key (pnpm/berry quote keys like '@babel/core@npm:^7.0.0'). Returns null
// when the line is not a key line (e.g. a sequence item).
function splitKeyValue(content: string): { key: string; rest: string } | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
    } else if (inDouble) {
      if (c === "\\") i++;
      else if (c === '"') inDouble = false;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === ":" && (i + 1 >= content.length || content[i + 1] === " ")) {
      return { key: content.slice(0, i), rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

interface Cursor {
  lines: Line[];
  idx: number;
}

function parseBlock(cur: Cursor, minIndent: number): YamlNode {
  const first = cur.lines[cur.idx]!;
  if (first.content.startsWith("- ") || first.content === "-") return parseSeq(cur, first.indent);
  return parseMap(cur, first.indent, minIndent);
}

function parseMap(cur: Cursor, indent: number, _minIndent: number): YamlMap {
  const entries: YamlMapEntry[] = [];
  const startLine = cur.lines[cur.idx]!.lineNo;
  while (cur.idx < cur.lines.length) {
    const line = cur.lines[cur.idx]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlLiteError("unexpected indentation", line.lineNo);
    const kv = splitKeyValue(line.content);
    if (kv === null) throw new YamlLiteError(`expected 'key: value', got ${JSON.stringify(line.content)}`, line.lineNo);
    const key = unquoteScalar(kv.key, line.lineNo);
    const keyLine = line.lineNo;
    cur.idx++;
    let value: YamlNode;
    if (kv.rest === "" || kv.rest === "{}" || kv.rest === "[]") {
      // nested block (deeper indent) OR an explicit empty collection OR an empty value
      if (kv.rest === "") {
        const next = cur.lines[cur.idx];
        if (next !== undefined && next.indent > indent) {
          value = parseBlock(cur, indent + 1);
        } else {
          value = { kind: "scalar", value: "", line: keyLine };
        }
      } else {
        value = kv.rest === "{}" ? { kind: "map", entries: [], line: keyLine } : { kind: "seq", items: [], line: keyLine };
      }
    } else {
      value = { kind: "scalar", value: unquoteScalar(kv.rest, keyLine), line: keyLine };
    }
    entries.push({ key, keyLine, value });
  }
  return { kind: "map", entries, line: startLine };
}

function parseSeq(cur: Cursor, indent: number): YamlSeq {
  const items: YamlNode[] = [];
  const startLine = cur.lines[cur.idx]!.lineNo;
  while (cur.idx < cur.lines.length) {
    const line = cur.lines[cur.idx]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlLiteError("unexpected indentation in sequence", line.lineNo);
    if (!(line.content === "-" || line.content.startsWith("- ")))
      throw new YamlLiteError("expected a sequence item", line.lineNo);
    const rest = line.content === "-" ? "" : line.content.slice(2).trim();
    cur.idx++;
    if (rest === "") {
      const next = cur.lines[cur.idx];
      if (next !== undefined && next.indent > indent) items.push(parseBlock(cur, indent + 1));
      else items.push({ kind: "scalar", value: "", line: line.lineNo });
    } else {
      items.push({ kind: "scalar", value: unquoteScalar(rest, line.lineNo), line: line.lineNo });
    }
  }
  return { kind: "seq", items, line: startLine };
}

export function parseYamlLite(text: string): YamlNode {
  const lines = scan(text);
  if (lines.length === 0) return { kind: "map", entries: [], line: 1 };
  const cur: Cursor = { lines, idx: 0 };
  const node = parseBlock(cur, 0);
  if (cur.idx < cur.lines.length)
    throw new YamlLiteError("unexpected trailing content", cur.lines[cur.idx]!.lineNo);
  return node;
}

// ---- navigation helpers (used by the pnpm/berry resolvers) --------------------------------
export function asMap(node: YamlNode | undefined): YamlMap | null {
  return node !== undefined && node.kind === "map" ? node : null;
}
export function asScalar(node: YamlNode | undefined): string | null {
  return node !== undefined && node.kind === "scalar" ? node.value : null;
}
export function getEntry(map: YamlMap | null, key: string): YamlMapEntry | null {
  if (map === null) return null;
  for (const e of map.entries) if (e.key === key) return e;
  return null;
}
export function getChild(map: YamlMap | null, key: string): YamlNode | undefined {
  return getEntry(map, key)?.value;
}

// The 1-based line span [start, end] covered by a mapping ENTRY: from its key line through the
// last line of its value subtree (for a permalink range over a lockfile block).
export function nodeLineSpan(entry: YamlMapEntry): [number, number] {
  return [entry.keyLine, maxLine(entry.value, entry.keyLine)];
}
function maxLine(node: YamlNode, acc: number): number {
  let max = Math.max(acc, node.line);
  if (node.kind === "map") for (const e of node.entries) max = Math.max(max, e.keyLine, maxLine(e.value, max));
  else if (node.kind === "seq") for (const it of node.items) max = Math.max(max, maxLine(it, max));
  return max;
}
