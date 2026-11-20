/** The Flutter app hosting this reader (flutter_inappwebview), if any. */
type FlutterHost = { callHandler: (name: string, data?: unknown) => Promise<unknown> };

export const flutterHost = (): FlutterHost | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { flutter_inappwebview?: FlutterHost }).flutter_inappwebview;

/** True inside the Flutter app (build flag or a live bridge). */
export const isFlutterHost = (): boolean =>
  typeof window !== 'undefined' &&
  (process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'flutter' || !!flutterHost());

/** Fire-and-forget call into a Flutter JavaScript handler. */
export const callFlutter = (name: string, data?: unknown) => {
  flutterHost()
    ?.callHandler(name, data)
    .catch(() => {});
};
