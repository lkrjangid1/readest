import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useThemeStore } from '@/store/themeStore';
import { saveViewSettings } from '@/helpers/settings';
import { getStyles } from '@/utils/style';
import { getMaxInlineSize } from '@/utils/config';
import { useSettingsStore } from '@/store/settingsStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useNotebookStore } from '@/store/notebookStore';
import { eventDispatcher } from '@/utils/event';
import { SERIF_FONTS, SANS_SERIF_FONTS, NON_FREE_FONTS } from '@/services/constants';
import type { TOCItem } from '@/libs/document';
import { findTocItemBS } from '@/services/nav';
import { forgetFlutterSection, getSectionSample } from '@/utils/flutterSectionNotifier';

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
  /** Live reader state for the Flutter chrome (bookmark, TTS, overlays…). */
  getState: () => Record<string, unknown>;
  /** Runs one of the web reader's own features (see `actions`). */
  action: (name: string, arg?: unknown) => Promise<boolean>;
  /** A quote from the chapter just finished (see onSectionChange), or null. */
  getSectionSample: () => Promise<string | null>;
};

declare global {
  interface Window {
    __readestFlutterBridge?: Bridge;
  }
}

type FlutterHost = { callHandler: (name: string, data?: unknown) => Promise<unknown> };
const flutterHost = (): FlutterHost | undefined =>
  (window as unknown as { flutter_inappwebview?: FlutterHost }).flutter_inappwebview;

const callFlutter = (name: string, data?: unknown) => {
  flutterHost()
    ?.callHandler(name, data)
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

    const overlayOpen = () =>
      useSidebarStore.getState().isSideBarVisible ||
      useNotebookStore.getState().isNotebookVisible ||
      useSettingsStore.getState().isSettingsDialogOpen;

    const unsubscribe = useReaderStore.subscribe((state, prev) => {
      if (!chromeHidden) return;
      // The web reader just tried to show its bars (a tap in the middle):
      // keep them hidden and let Flutter toggle its own chrome instead.
      if (state.hoveredBookKey && state.hoveredBookKey !== prev.hoveredBookKey) {
        state.setHoveredBookKey(null);
        // Closing the sidebar also sets it; that isn't a page tap.
        if (!overlayOpen()) callFlutter('onCenterTap');
      }
    });

    // Read-aloud state changes, so the Listen button can follow them.
    const onTtsState = (e: CustomEvent) => {
      const d = e.detail as { bookKey?: string; state?: string } | undefined;
      if (!d || d.bookKey === bookKey) callFlutter('onReaderState', { tts: d?.state });
    };
    eventDispatcher.on('tts-playback-state', onTtsState);

    const freeFont = (f: string) => !NON_FREE_FONTS.includes(f);

    const actions: Record<string, (arg?: unknown) => Promise<boolean> | boolean> = {
      toggleBookmark: () => {
        eventDispatcher.dispatch('toggle-bookmark', { bookKey });
        return true;
      },
      search: (term) => {
        eventDispatcher.dispatch('search-term', {
          term: typeof term === 'string' && term ? term : null,
          bookKey,
        });
        return true;
      },
      tts: () => {
        const on = !!reader().getViewState(bookKey)?.ttsEnabled;
        eventDispatcher.dispatch(on ? 'tts-stop' : 'tts-speak', { bookKey });
        return true;
      },
      ttsPause: () => {
        eventDispatcher.dispatch('tts-toggle-play', { bookKey });
        return true;
      },
      // Read-aloud off (e.g. the free daily minutes ran out); no-op when off.
      ttsStop: () => {
        if (!reader().getViewState(bookKey)?.ttsEnabled) return false;
        eventDispatcher.dispatch('tts-stop', { bookKey });
        return true;
      },
      settings: (panel) => {
        const st = useSettingsStore.getState();
        st.setRequestedPanel(typeof panel === 'string' ? panel : null);
        st.setSettingsDialogBookKey(bookKey);
        st.setSettingsDialogOpen(true);
        return true;
      },
      sidebar: (tab) => {
        const sb = useSidebarStore.getState();
        const config = useBookDataStore.getState().getConfig(bookKey);
        if (config && typeof tab === 'string') {
          useBookDataStore.getState().setConfig(bookKey, {
            viewSettings: { ...config.viewSettings!, sideBarTab: tab },
          });
        }
        // The sidebar reads its tab when it mounts, so reopen it.
        sb.setSideBarVisible(false);
        sb.setSideBarBookKey(bookKey);
        setTimeout(() => useSidebarStore.getState().setSideBarVisible(true), 0);
        return true;
      },
      notebook: () => {
        useSidebarStore.getState().setSideBarBookKey(bookKey);
        useNotebookStore.getState().setNotebookVisible(true);
        return true;
      },
      prevPage: () => !!reader().getView(bookKey)?.renderer.prev(),
      nextPage: () => !!reader().getView(bookKey)?.renderer.next(),
      prevSection: () => {
        reader().getView(bookKey)?.renderer.prevSection?.();
        return true;
      },
      nextSection: () => {
        reader().getView(bookKey)?.renderer.nextSection?.();
        return true;
      },
      back: () => {
        reader().getView(bookKey)?.history.back();
        return true;
      },
      forward: () => {
        reader().getView(bookKey)?.history.forward();
        return true;
      },
      paragraphMode: () => {
        eventDispatcher.dispatch('toggle-paragraph-mode', { bookKey });
        return true;
      },
      speedReading: () => {
        eventDispatcher.dispatch('rsvp-start', { bookKey });
        return true;
      },
      autoScroll: () => {
        eventDispatcher.dispatch('autoscroll-toggle', { bookKey });
        return true;
      },
      font: async (arg) => {
        const name = String(arg ?? '');
        if (SANS_SERIF_FONTS.includes(name)) {
          await saveViewSettings(envConfig, bookKey, 'sansSerifFont', name);
          await saveViewSettings(envConfig, bookKey, 'defaultFont', 'Sans-serif');
        } else {
          await saveViewSettings(envConfig, bookKey, 'serifFont', name);
          await saveViewSettings(envConfig, bookKey, 'defaultFont', 'Serif');
        }
        return true;
      },
      // Android back: close the web reader's own panels first.
      closeOverlays: () => {
        let closed = false;
        const sb = useSidebarStore.getState();
        if (useSettingsStore.getState().isSettingsDialogOpen) {
          useSettingsStore.getState().setSettingsDialogOpen(false);
          closed = true;
        }
        if (useNotebookStore.getState().isNotebookVisible) {
          useNotebookStore.getState().setNotebookVisible(false);
          closed = true;
        }
        if (sb.isSideBarVisible) {
          sb.setSideBarVisible(false);
          closed = true;
        }
        if (sb.isSearchBarVisible) {
          sb.clearSearch(bookKey);
          sb.setSearchBarVisible(false);
          reader().getView(bookKey)?.clearSearch?.();
          closed = true;
        }
        return closed;
      },
    };

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

      getState: () => {
        const viewState = reader().getViewState(bookKey);
        const vs = reader().getViewSettings(bookKey);
        const view = reader().getView(bookKey);
        return {
          bookmarked: !!viewState?.ribbonVisible,
          ttsEnabled: !!viewState?.ttsEnabled,
          autoScroll: !!viewState?.autoScrollEnabled,
          paragraphMode: !!vs?.paragraphMode?.enabled,
          fixedLayout: !!useBookDataStore.getState().getBookData(bookKey)?.isFixedLayout,
          canGoBack: !!view?.history?.canGoBack,
          canGoForward: !!view?.history?.canGoForward,
          overlayOpen: overlayOpen(),
          defaultFont: vs?.defaultFont ?? 'Serif',
          serifFont: vs?.serifFont ?? '',
          sansSerifFont: vs?.sansSerifFont ?? '',
          serifFonts: SERIF_FONTS.filter(freeFont),
          sansSerifFonts: SANS_SERIF_FONTS.filter(freeFont),
          bookTitle: useBookDataStore.getState().getBookData(bookKey)?.book?.title ?? '',
          author: useBookDataStore.getState().getBookData(bookKey)?.book?.author ?? '',
        };
      },

      action: async (name, arg) => {
        const fn = actions[name];
        if (!fn) return false;
        return !!(await fn(arg));
      },

      getSectionSample: () =>
        getSectionSample(bookKey, useBookDataStore.getState().getBookData(bookKey)),

      getBooknotes: () => {
        const toc = useBookDataStore.getState().getBookData(bookKey)?.bookDoc?.toc ?? [];
        const chapterOf = (cfi: string) => {
          try {
            return (findTocItemBS(toc, cfi)?.label ?? '').trim();
          } catch {
            return '';
          }
        };
        return (useBookDataStore.getState().getConfig(bookKey)?.booknotes ?? [])
          .filter((n) => !n.deletedAt && n.cfi)
          .map((n) => ({
            id: n.id,
            type: n.type,
            cfi: n.cfi,
            text: n.text ?? '',
            note: n.note ?? '',
            color: n.color ?? null,
            style: n.style ?? null,
            page: n.page ?? null,
            chapter: chapterOf(n.cfi),
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
          }));
      },
    };

    window.__readestFlutterBridge = bridge;
    callFlutter('onReaderBridgeReady');
    return () => {
      unsubscribe();
      forgetFlutterSection(bookKey);
      eventDispatcher.off('tts-playback-state', onTtsState);
      if (window.__readestFlutterBridge === bridge) delete window.__readestFlutterBridge;
    };
  }, [bookKey, envConfig]);

  return null;
};

export default FlutterBridge;
