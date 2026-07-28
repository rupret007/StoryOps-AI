import { csvCell } from '@/core/integrations/csvSecurity';

export function downloadText(
  filename: string,
  contents: string,
  mediaType = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([contents], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function rowsToCsv(rows: readonly (readonly (string | number)[])[]): string {
  return `${rows.map((row) => row.map((value) => csvCell(value)).join(',')).join('\r\n')}\r\n`;
}

export function escapeIcsText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(/\r\n|\r|\n/gu, '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

export function safeDownloadFilename(value: string, fallback = 'storyops-export'): string {
  const normalized = [...value.normalize('NFKC')]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 || '/\\:*?"<>|'.includes(character) ? '-' : character;
    })
    .join('')
    .replaceAll(/\s+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replaceAll(/^[.\-\s]+|[.\-\s]+$/gu, '')
    .slice(0, 120);
  return normalized || fallback;
}
