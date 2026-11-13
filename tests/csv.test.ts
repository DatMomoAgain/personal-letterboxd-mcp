import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.ts";

describe("parseCsv", () => {
  it("parses header and rows", () => {
    expect(parseCsv("Date,Name\n2025-01-01,Heat\n")).toEqual([
      { Date: "2025-01-01", Name: "Heat" },
    ]);
  });

  it("parses quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv(
      'Name,Year\n"Crouching Tiger, Hidden Dragon",2000\n"The ""Best"" Film",1999',
    );
    expect(rows.map((r) => r.Name)).toEqual([
      "Crouching Tiger, Hidden Dragon",
      'The "Best" Film',
    ]);
    expect(rows[1].Year).toBe("1999");
  });

  it("handles CRLF, BOM, and newline inside quotes", () => {
    const rows = parseCsv('﻿Name,Review\r\nHeat,"Line one\r\nLine two"\r\nAlien,ok\r\n');
    expect(rows).toEqual([
      { Name: "Heat", Review: "Line one\r\nLine two" },
      { Name: "Alien", Review: "ok" },
    ]);
  });

  it("header-only file returns []", () => {
    expect(parseCsv("Date,Content,Comment\n")).toEqual([]);
  });
});
