// csvWrite.ts — pure CSV serialization for the export layer (EXPORTS.md contract). Three rules,
// all pinned by golden tests:
//   1. RFC 4180: fields containing comma, double-quote, CR or LF are double-quoted with embedded
//      quotes doubled; rows end CRLF; the document ends with a trailing CRLF.
//   2. OWASP formula-injection defense on STRING cells: a cell gets a literal apostrophe prefix
//      INSIDE the field — so Excel/Sheets render it as text instead of executing it — when its
//      first byte is TAB or CR (themselves triggers, catching "\t=cmd..."), OR when its first
//      VISIBLE character (after any leading whitespace a spreadsheet may trim on open) is = + - @.
//      A benign leading-whitespace value whose first visible char is not a trigger (e.g. " ^50.0.0")
//      is left unchanged. Typed NUMBER cells are exempt — a negative count is a sign, not a formula
//      — and JSONL exports stay byte-faithful (the defense exists only in this writer).
//   3. Determinism: pure function of its inputs; the caller supplies column order (the export
//      column registry) and row order (the export queries' ORDER BY).

export type CsvCell = string | number | null;

const NEEDS_QUOTING = /[",\r\n]/;
// OWASP formula-injection defense. A cell is neutralized (apostrophe-prefixed) when it is a formula
// in a spreadsheet's eyes: it starts with a control-char trigger (TAB or CR), OR — after any leading
// whitespace a spreadsheet may trim on open — its first visible character is `= + - @`. The leading
// `\s*` closes the ` =cmd|...` bypass that a bare first-byte check (`/^[=+\-@\t\r]/`) missed, WITHOUT
// over-neutralizing benign leading-whitespace values (e.g. a stray-spaced version ` ^50.0.0`, whose
// `^` is not a trigger). Typed NUMBER cells are exempt (handled before this test).
const FORMULA_TRIGGER = /^[\t\r]|^\s*[=+\-@]/;

export function csvCell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "number") {
    // Export columns are TEXT/INTEGER; a float or non-finite number reaching the writer is a
    // column-registry drift — fail loudly rather than bake it into golden files.
    if (!Number.isSafeInteger(value)) throw new Error(`csvCell expects integers, got: ${value}`);
    return String(value);
  }
  const defended = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(defended) ? `"${defended.replaceAll('"', '""')}"` : defended;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  const lines: string[] = [header.map((h) => csvCell(h)).join(",")];
  for (const row of rows) {
    if (row.length !== header.length)
      throw new Error(`csv row has ${row.length} cells, header has ${header.length}`);
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
