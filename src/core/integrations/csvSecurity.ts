const spreadsheetFormulaPrefix = /^[\t\r\n ]*[=+\-@]/u;

export function neutralizeSpreadsheetFormula(value: string | number): string {
  const text = String(value);
  return spreadsheetFormulaPrefix.test(text) ? `'${text}` : text;
}

export function csvCell(value: string | number, alwaysQuote = false): string {
  const text = neutralizeSpreadsheetFormula(value);
  return alwaysQuote || /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
