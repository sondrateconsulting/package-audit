// dims.test.ts — readRawDims, the ONE RawDims constructor (§U5): the proxy's getRawDims and the
// App's plain-stream fallback both build their RawDims through it, so the type holds on both paths.
import { describe, expect, test } from "bun:test";
import { readRawDims } from "./dims.ts";

describe("readRawDims — a number passes through raw; anything else is undefined", () => {
  test("numbers pass through untouched, non-renderable ones included (judging is isPositiveIntegerDim's job)", () => {
    for (const v of [120, 0, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect({ v, dims: readRawDims({ columns: v, rows: v }) }).toEqual({ v, dims: { columns: v, rows: v } });
    }
  });

  test("a non-number a foreign stream carries never reaches RawDims", () => {
    for (const v of ["80", null, true, {}, [], Symbol("columns"), 80n, () => 80]) {
      expect(readRawDims({ columns: v, rows: v })).toEqual({ columns: undefined, rows: undefined });
    }
  });

  test("a writable with no TTY dimensions at all reads as undefined, never a default", () => {
    expect(readRawDims({})).toEqual({ columns: undefined, rows: undefined });
  });

  test("each axis is read independently", () => {
    expect(readRawDims({ columns: 100, rows: "30" })).toEqual({ columns: 100, rows: undefined });
    expect(readRawDims({ rows: 30 })).toEqual({ columns: undefined, rows: 30 });
  });
});
