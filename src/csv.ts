/**
 * Minimal RFC 4180 CSV parser: quoted fields, "" escapes, CRLF/LF line endings,
 * newlines inside quoted fields, optional BOM. First row is the header.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text.replace(/^﻿/, ""));
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key] = cells[i] ?? "";
    });
    return record;
  });
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Skip fully blank lines (e.g. a trailing newline).
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r" && text[i + 1] === "\n") {
      endRow();
      i++;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
