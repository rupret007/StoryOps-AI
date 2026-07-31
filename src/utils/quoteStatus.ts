export function customerFacingQuoteStatus(status: string): string {
  if (status === 'sent') return 'published to portal';
  return status.replaceAll('_', ' ');
}
