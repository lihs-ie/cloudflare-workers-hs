import { expect, it } from 'vitest';

export function registerUrlShortenerDatabaseCases(
  prepare: () => Promise<{ label: string; count: number }>,
): void {
  it('executes the UrlShortener prepared-query wrapper with bound values', async () => {
    expect(await prepare()).toEqual({ label: 'prepared-value', count: 7 });
  });
}
