import { describe, expect, it } from 'vitest';
import { shouldRunReaderEntry } from '@/pages/read/entryGate';

const base = {
  routerReady: true,
  isImporting: false,
  hasHydrated: false,
  error: null as string | null,
  file: '',
  bookId: '',
};

describe('shouldRunReaderEntry', () => {
  it('runs for a normal file navigation', () => {
    expect(shouldRunReaderEntry({ ...base, file: '/books/a.epub' })).toBe(true);
  });

  it('runs for a book-hash navigation', () => {
    expect(shouldRunReaderEntry({ ...base, bookId: 'abc123' })).toBe(true);
  });

  it('stays quiet on a bare boot (headless pre-warm without ?file/?book)', () => {
    // Regression: this used to throw "Provide either a book hash…" and then
    // retry forever because the effect re-armed on the isImporting toggle.
    expect(shouldRunReaderEntry(base)).toBe(false);
  });

  it('does not retry after an error (no infinite import loop)', () => {
    expect(shouldRunReaderEntry({ ...base, file: '/books/a.epub', error: 'boom' })).toBe(false);
  });

  it('does not run before the router is ready, mid-import, or once hydrated', () => {
    expect(shouldRunReaderEntry({ ...base, file: 'x', routerReady: false })).toBe(false);
    expect(shouldRunReaderEntry({ ...base, file: 'x', isImporting: true })).toBe(false);
    expect(shouldRunReaderEntry({ ...base, file: 'x', hasHydrated: true })).toBe(false);
  });
});
