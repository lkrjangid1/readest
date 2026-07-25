/**
 * Whether the /read entry effect should attempt to resolve and import a book.
 *
 * Two states must NOT run (both used to enter an infinite import-retry loop,
 * because the effect re-armed itself on the `isImporting` true→false toggle):
 *  - a bare boot with neither `?file=` nor `?book=` — the Flutter host
 *    pre-warms the headless WebView on `read.html` without a target, which is
 *    a normal state, not an error;
 *  - a failed previous attempt (`error` set) — retries are pointless until a
 *    new navigation or a `flutter-reader-update` event resets the state.
 */
export const shouldRunReaderEntry = (opts: {
  routerReady: boolean;
  isImporting: boolean;
  hasHydrated: boolean;
  error: string | null;
  file: string;
  bookId: string;
}): boolean =>
  opts.routerReady &&
  !opts.isImporting &&
  !opts.hasHydrated &&
  !opts.error &&
  Boolean(opts.file || opts.bookId);
