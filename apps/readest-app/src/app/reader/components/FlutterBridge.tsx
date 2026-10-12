import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useThemeStore } from '@/store/themeStore';
import { saveViewSettings } from '@/helpers/settings';
import { getStyles } from '@/utils/style';
import { getMaxInlineSize } from '@/utils/config';
import type { TOCItem } from '@/libs/document';

const MAX_MARGIN_PX = 88;
const MAX_GAP_PERCENT = 10;

/** Settings the Flutter "Aa" sheet reads and writes. */
interface FlutterViewSettings {
  fontSize?: number;
  lineHeight?: number;
  defaultFont?: 'Serif' | 'Sans-serif';
  /** 0..100, like the web margin slider. */
  margin?: number;
  scrolled?: boolean;
  justify?: boolean;
  themeMode?: 'auto' | 'light' | 'dark';
  themeColor?: string;
}

type Bridge = {
  getToc: () => { label: string; href: string; level: number; current: boolean }[];
  getViewSettings: () => FlutterViewSettings | null;
  setViewSettings: (partial: FlutterViewSettings) => Promise<boolean>;
  goTo: (target: string | number) => Promise<boolean>;
  hideChrome: (hidden: boolean) => boolean;
  getProgress: () => Record<string, unknown> | null;
  getBooknotes: () => Record<string, unknown>[];
};

declare global {
  interface Window {
    __readestFlutterBridge?: Bridge;
  }
}

type FlutterHost = { callHandler: (name: string, data?: unknown) => Promise<unknown> };
const flutterHost = (): FlutterHost | undefined =>
  (window as unknown as { flutter_inappwebview?: FlutterHost }).flutter_inappwebview;

const callFlutter = (name: string) => {
  flutterHost()
    ?.callHandler(name)
    .catch(() => {});
};

const isFlutter = () =>
  typeof window !== 'undefined' &&
  (process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'flutter' || !!flutterHost());

/**
 * Exposes the live reader to Flutter (TOC, view settings, navigation,
 * progress, booknotes) and lets Flutter draw the reader chrome itself:
 * with hideChrome(true) the web header/footer never show, and a tap in the
 * middle of the page is forwarded as `onCenterTap`.
 */
const FlutterBridge: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const { envConfig } = useEnv();

  useEffect(() => {
    if (!isFlutter()) return;
    let chromeHidden = false;

    const reader = () => useReaderStore.getState();

    const unsubscribe = useReaderStore.subscribe((state, prev) => {
      if (!chromeHidden) return;
      // The web reader just tried to show its bars (a tap in the middle):
      // keep them hidden and let Flutter toggle its own chrome instead.
      if (state.hoveredBookKey && state.hoveredBookKey !== prev.hoveredBookKey) {
        state.setHoveredBookKey(null);
        callFlutter('onCenterTap');
      }
    });

    const flatten = (items: TOCItem[] | undefined, level: number, current?: string) =>
      (items ?? []).flatMap(
        (it): { label: string; href: string; level: number; current: boolean }[] => [
          { label: (it.label ?? '').trim(), href: it.href, level, current: it.href === current },
          ...flatten(it.subitems, level + 1, current),
        ],
      );

    const bridge: Bridge = {
      getToc: () => {
        const toc = useBookDataStore.getState().getBookData(bookKey)?.bookDoc?.toc;
        return flatten(toc, 0, reader().getProgress(bookKey)?.sectionHref);
      },

      getViewSettings: () => {
        const vs = reader().getViewSettings(bookKey);
        if (!vs) return null;
        const { themeMode, themeColor } = useThemeStore.getState();
        return {
          fontSize: vs.defaultFontSize,
          lineHeight: vs.lineHeight,
          defaultFont: vs.defaultFont as FlutterViewSettings['defaultFont'],
          margin: Math.round(
            ((vs.marginTopPx ?? 0) / MAX_MARGIN_PX + (vs.gapPercent ?? 0) / MAX_GAP_PERCENT) * 50,
          ),
          scrolled: !!vs.scrolled,
          justify: !!vs.fullJustification,
          themeMode,
          themeColor,
        };
      },

      setViewSettings: async (p) => {
        const vs = reader().getViewSettings(bookKey);
        const view = reader().getView(bookKey);
        if (!vs) return false;
        if (p.fontSize != null)
          await saveViewSettings(envConfig, bookKey, 'defaultFontSize', p.fontSize);
        if (p.lineHeight != null)
          await saveViewSettings(envConfig, bookKey, 'lineHeight', p.lineHeight);
        if (p.defaultFont) await saveViewSettings(envConfig, bookKey, 'defaultFont', p.defaultFont);
        if (p.justify != null)
          await saveViewSettings(envConfig, bookKey, 'fullJustification', p.justify);
        if (p.margin != null) {
          const marginPx = Math.round((p.margin / 100) * MAX_MARGIN_PX);
          const gapPercent = Math.round((p.margin / 100) * MAX_GAP_PERCENT);
          vs.marginTopPx = marginPx;
          vs.marginBottomPx = marginPx / 2;
          vs.marginLeftPx = marginPx / 2;
          vs.marginRightPx = marginPx / 2;
          await saveViewSettings(envConfig, bookKey, 'gapPercent', gapPercent, false, false);
          view?.renderer.setAttribute('margin', `${marginPx}px`);
          view?.renderer.setAttribute('gap', `${gapPercent}%`);
          if (vs.scrolled) view?.renderer.setAttribute('flow', 'scrolled');
        }
        if (p.scrolled != null && p.scrolled !== vs.scrolled) {
          // Persist first: saveViewSettings skips values that already match.
          await saveViewSettings(envConfig, bookKey, 'scrolled', p.scrolled, false, false);
          view?.renderer.setAttribute('flow', p.scrolled ? 'scrolled' : 'paginated');
          view?.renderer.setAttribute('max-inline-size', `${getMaxInlineSize(vs)}px`);
          view?.renderer.setStyles?.(getStyles(vs));
        }
        if (p.themeMode) useThemeStore.getState().setThemeMode(p.themeMode);
        if (p.themeColor) useThemeStore.getState().setThemeColor(p.themeColor);
        return true;
      },

      goTo: async (target) => {
        const view = reader().getView(bookKey);
        if (!view) return false;
        if (typeof target === 'number') {
          view.goToFraction(Math.min(1, Math.max(0, target)));
        } else {
          await view.goTo(target);
        }
        return true;
      },

      hideChrome: (hidden) => {
        chromeHidden = hidden;
        if (hidden) reader().setHoveredBookKey(null);
        return true;
      },

      getProgress: () => {
        const p = reader().getProgress(bookKey);
        if (!p) return null;
        const bookData = useBookDataStore.getState().getBookData(bookKey);
        const info = bookData?.isFixedLayout ? p.section : p.pageinfo;
        return {
          fraction: info && info.total > 0 ? (info.current + 1) / info.total : p.fraction,
          sectionLabel: p.sectionLabel ?? '',
          sectionHref: p.sectionHref ?? '',
          page: info ? info.current + 1 : null,
          pages: info ? info.total : null,
          minutesLeftInSection: p.timeinfo?.section ?? null,
          location: p.location,
          bookmarked: !!reader().getViewState(bookKey)?.ribbonVisible,
        };
      },

      getBooknotes: () =>
        (useBookDataStore.getState().getConfig(bookKey)?.booknotes ?? [])
          .filter((n) => !n.deletedAt && n.cfi)
          .map((n) => ({
            id: n.id,
            type: n.type,
            cfi: n.cfi,
            text: n.text ?? '',
            note: n.note ?? '',
            color: n.color ?? null,
            createdAt: n.createdAt,
          })),
    };

    window.__readestFlutterBridge = bridge;
    callFlutter('onReaderBridgeReady');
    return () => {
      unsubscribe();
      if (window.__readestFlutterBridge === bridge) delete window.__readestFlutterBridge;
    };
  }, [bookKey, envConfig]);

  return null;
};

export default FlutterBridge;
