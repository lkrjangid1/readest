import { create } from 'zustand';

import {
  BookContent,
  BookConfig,
  PageInfo,
  BookProgress,
  ViewSettings,
  TimeInfo,
  FIXED_LAYOUT_FORMATS,
} from '@/types/book';
import { Insets } from '@/types/misc';
import { EnvConfigType } from '@/services/environment';
import { FoliateView } from '@/types/view';
import { DocumentLoader, TOCItem } from '@/libs/document';
import { updateToc } from '@/utils/toc';
import { formatTitle, getMetadataHash, getPrimaryLanguage } from '@/utils/book';
import { getBaseFilename } from '@/utils/path';
import { SUPPORTED_LANGNAMES } from '@/services/constants';
import { useSettingsStore } from './settingsStore';
import { useBookDataStore } from './bookDataStore';
import { useLibraryStore } from './libraryStore';

type FlutterProgressPayload = {
  progress: [number, number];
  filePath?: string;
};

const pendingFlutterProgress: FlutterProgressPayload[] = [];
let flutterBridgeListenerAttached = false;
let flutterBridgePollTimer: number | null = null;

function notifyFlutterAboutProgress(progress: [number, number], filePath?: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const payload: FlutterProgressPayload = {
    progress,
    filePath:
      filePath ||
      (window as any).__FLUTTER_BOOK_DATA__?.book?.filePath ||
      (window as any).__FLUTTER_BOOK_DATA__?.filePath,
  };

  if (!trySendProgressToFlutter(payload)) {
    queueProgressPayload(payload);
  }
}

function queueProgressPayload(payload: FlutterProgressPayload) {
  if (pendingFlutterProgress.length > 200) {
    pendingFlutterProgress.shift();
  }
  pendingFlutterProgress.push(payload);
  startFlutterBridgePolling();
  attachFlutterBridgeListener();
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[FlutterBridge] queueing progress update', payload);
  }
}

function trySendProgressToFlutter(payload: FlutterProgressPayload): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const bridgePayload = {
      progress: payload.progress,
      bookId:
        (window as any).__FLUTTER_BOOK_DATA__?.book?.hash ||
        (window as any).FlutterReaderAPI?.currentBook?.hash,
      filePath: payload.filePath,
    };

    const webviewBridge = (window as any).flutter_inappwebview;
    if (webviewBridge?.callHandler) {
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[FlutterBridge] sending progress via flutter_inappwebview', bridgePayload);
      }
      webviewBridge.callHandler('onProgressUpdate', bridgePayload);
      return true;
    }

    const flutterApi = (window as any).FlutterReaderAPI;
    if (!flutterApi || typeof flutterApi.setProgress !== 'function') {
      return false;
    }

    if (process.env.NODE_ENV !== 'production') {
      console.debug('[FlutterBridge] sending progress via FlutterReaderAPI', payload);
    }
    flutterApi.setProgress(payload.progress, { filePath: payload.filePath });
    return true;
  } catch (error) {
    console.warn('Failed to notify Flutter about progress:', error);
    return false;
  }
}

function attachFlutterBridgeListener() {
  if (typeof window === 'undefined' || flutterBridgeListenerAttached) {
    return;
  }

  flutterBridgeListenerAttached = true;

  const flushQueue = () => {
    if (pendingFlutterProgress.length === 0) {
      return;
    }

    let safety = 0;
    while (pendingFlutterProgress.length && safety < 50) {
      safety += 1;
      const update = pendingFlutterProgress.shift()!;
      const sent = trySendProgressToFlutter(update);
      if (!sent) {
        pendingFlutterProgress.unshift(update);
        break;
      }
    }
  };

  const readyEvents = ['flutter-reader-api-ready', 'flutter-reader-ready', 'flutter-reader-update'] as const;

  readyEvents.forEach((eventName) => {
    window.addEventListener(eventName as any, flushQueue as EventListener);
  });

  window.addEventListener('load', flushQueue as EventListener);
  setTimeout(flushQueue, 0);
}

function startFlutterBridgePolling() {
  if (typeof window === 'undefined') {
    return;
  }
  if (flutterBridgePollTimer !== null) {
    return;
  }

  flutterBridgePollTimer = window.setInterval(() => {
    if (pendingFlutterProgress.length === 0) {
      if (flutterBridgePollTimer !== null) {
        window.clearInterval(flutterBridgePollTimer);
        flutterBridgePollTimer = null;
      }
      return;
    }

    const next = pendingFlutterProgress[0]!;
    if (trySendProgressToFlutter(next)) {
      pendingFlutterProgress.shift();
    }
  }, 1000);
}

interface ViewState {
  /* Unique key for each book view */
  key: string;
  view: FoliateView | null;
  isPrimary: boolean;
  loading: boolean;
  inited: boolean;
  error: string | null;
  progress: BookProgress | null;
  ribbonVisible: boolean;
  ttsEnabled: boolean;
  syncing: boolean;
  gridInsets: Insets | null;
  /* View settings for the view: 
    generally view settings have a hierarchy of global settings < book settings < view settings
    view settings for primary view are saved to book config which is persisted to config file
    omitting settings that are not changed from global settings */
  viewSettings: ViewSettings | null;
}

interface ReaderStore {
  viewStates: { [key: string]: ViewState };
  bookKeys: string[];
  hoveredBookKey: string | null;
  setBookKeys: (keys: string[]) => void;
  setHoveredBookKey: (key: string | null) => void;
  setBookmarkRibbonVisibility: (key: string, visible: boolean) => void;
  setTTSEnabled: (key: string, enabled: boolean) => void;
  setIsSyncing: (key: string, syncing: boolean) => void;
  setProgress: (
    key: string,
    location: string,
    tocItem: TOCItem,
    section: PageInfo,
    pageinfo: PageInfo,
    timeinfo: TimeInfo,
    range: Range,
  ) => void;
  getProgress: (key: string) => BookProgress | null;
  setView: (key: string, view: FoliateView) => void;
  getView: (key: string | null) => FoliateView | null;
  getViews: () => FoliateView[];
  getViewsById: (id: string) => FoliateView[];
  setViewSettings: (key: string, viewSettings: ViewSettings) => void;
  getViewSettings: (key: string) => ViewSettings | null;

  initViewState: (
    envConfig: EnvConfigType,
    id: string,
    key: string,
    isPrimary?: boolean,
  ) => Promise<void>;
  clearViewState: (key: string) => void;
  getViewState: (key: string) => ViewState | null;
  getGridInsets: (key: string) => Insets | null;
  setGridInsets: (key: string, insets: Insets | null) => void;
  setViewInited: (key: string, inited: boolean) => void;
}

export const useReaderStore = create<ReaderStore>((set, get) => ({
  viewStates: {},
  bookKeys: [],
  hoveredBookKey: null,
  setBookKeys: (keys: string[]) => set({ bookKeys: keys }),
  setHoveredBookKey: (key: string | null) => set({ hoveredBookKey: key }),
  getView: (key: string | null) => (key && get().viewStates[key]?.view) || null,
  setView: (key: string, view) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: { ...state.viewStates[key]!, view },
      },
    })),
  getViews: () => Object.values(get().viewStates).map((state) => state.view!),
  getViewsById: (id: string) => {
    const { viewStates } = get();
    return Object.values(viewStates)
      .filter((state) => state.key && state.key.startsWith(id))
      .map((state) => state.view!);
  },

  clearViewState: (key: string) => {
    set((state) => {
      const viewStates = { ...state.viewStates };
      delete viewStates[key];
      return { viewStates };
    });
  },
  getViewState: (key: string) => get().viewStates[key] || null,
  initViewState: async (envConfig: EnvConfigType, id: string, key: string, isPrimary = true) => {
    const booksData = useBookDataStore.getState().booksData;
    const bookData = booksData[id];
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          key: '',
          view: null,
          isPrimary: false,
          loading: true,
          inited: false,
          error: null,
          progress: null,
          ribbonVisible: false,
          ttsEnabled: false,
          syncing: false,
          gridInsets: null,
          viewSettings: null,
        },
      },
    }));
    try {
      const { settings } = useSettingsStore.getState();
      if (!bookData) {
        const appService = await envConfig.getAppService();

        // Check if this is Flutter mode with pre-loaded book data
        const flutterBookData = (window as any).__FLUTTER_BOOK_DATA__;
        if (flutterBookData && flutterBookData.book && flutterBookData.book.hash === id) {
          const book = flutterBookData.book;
          const content = {
            book,
            file: book.file,
            config: {
              updatedAt: Date.now(),
              progress: book.progress || [1, 1],
              location: '',
              viewSettings: {},
              booknotes: []
            }
          } as BookContent;

          const { file, config } = content;
          console.log('Loading Flutter book', key);
          const { book: bookDoc } = await new DocumentLoader(file).open();
          updateToc(bookDoc, config.viewSettings?.sortedTOC ?? false);
          if (!bookDoc.metadata.title) {
            bookDoc.metadata.title = getBaseFilename(file.name);
          }
          book.sourceTitle = formatTitle(bookDoc.metadata.title);

          const isFixedLayout = FIXED_LAYOUT_FORMATS.has(book.format);
          useBookDataStore.setState((state) => ({
            booksData: {
              ...state.booksData,
              [id]: { id, book, file, config, bookDoc, isFixedLayout },
            },
          }));
        } else {
          // Original book loading logic
          let { library } = useLibraryStore.getState();
          let book = library.find((b) => b.hash === id);

          // If book not found in current library, try refreshing from file system
          if (!book) {
            console.log('Book not found in current library, refreshing...');
            library = await appService.loadLibraryBooks();
            useLibraryStore.getState().setLibrary(library);
            book = library.find((b) => b.hash === id);

            if (!book) {
              throw new Error('Book not found');
            }
            console.log('Book found after library refresh:', book.title);
          }
          const content = (await appService.loadBookContent(book, settings)) as BookContent;
          const { file, config } = content;
          console.log('Loading book', key);
          const { book: bookDoc } = await new DocumentLoader(file).open();
          updateToc(bookDoc, config.viewSettings?.sortedTOC ?? false);
          if (!bookDoc.metadata.title) {
            bookDoc.metadata.title = getBaseFilename(file.name);
          }
          book.sourceTitle = formatTitle(bookDoc.metadata.title);
          // Correct language codes mistakenly set with language names
          if (typeof bookDoc.metadata?.language === 'string') {
            if (bookDoc.metadata.language in SUPPORTED_LANGNAMES) {
              bookDoc.metadata.language = SUPPORTED_LANGNAMES[bookDoc.metadata.language]!;
            }
          }
          // Set the book's language for formerly imported books, newly imported books have this field set
          const primaryLanguage = getPrimaryLanguage(bookDoc.metadata.language);
          book.primaryLanguage = book.primaryLanguage ?? primaryLanguage;
          book.metadata = book.metadata ?? bookDoc.metadata;
          // TODO: uncomment this when we can ensure metaHash is correctly generated for all books
          // book.metaHash = book.metaHash ?? getMetadataHash(bookDoc.metadata);
          book.metaHash = getMetadataHash(bookDoc.metadata);

          const isFixedLayout = FIXED_LAYOUT_FORMATS.has(book.format);
          useBookDataStore.setState((state) => ({
            booksData: {
              ...state.booksData,
              [id]: { id, book, file, config, bookDoc, isFixedLayout },
            },
          }));
        }
      }
      const booksData = useBookDataStore.getState().booksData;
      const config = booksData[id]?.config as BookConfig;
      const configViewSettings = config.viewSettings!;
      const globalViewSettings = settings.globalViewSettings;
      set((state) => ({
        viewStates: {
          ...state.viewStates,
          [key]: {
            ...state.viewStates[key],
            key,
            view: null,
            isPrimary,
            loading: false,
            inited: false,
            error: null,
            progress: null,
            ribbonVisible: false,
            ttsEnabled: false,
            syncing: false,
            gridInsets: null,
            viewSettings: { ...globalViewSettings, ...configViewSettings },
          },
        },
      }));
    } catch (error) {
      console.error(error);
      set((state) => ({
        viewStates: {
          ...state.viewStates,
          [key]: {
            ...state.viewStates[key],
            key: '',
            view: null,
            isPrimary: false,
            loading: false,
            inited: false,
            error: 'Failed to load book.',
            progress: null,
            ribbonVisible: false,
            ttsEnabled: false,
            syncing: false,
            gridInsets: null,
            viewSettings: null,
          },
        },
      }));
    }
  },
  getViewSettings: (key: string) => get().viewStates[key]?.viewSettings || null,
  setViewSettings: (key: string, viewSettings: ViewSettings) => {
    if (!key) return;
    const id = key.split('-')[0]!;
    const bookData = useBookDataStore.getState().booksData[id];
    const viewState = get().viewStates[key];
    if (!viewState || !bookData) return;
    if (viewState.isPrimary) {
      useBookDataStore.setState((state) => ({
        booksData: {
          ...state.booksData,
          [id]: {
            ...bookData,
            config: {
              ...bookData.config,
              updatedAt: Date.now(),
              viewSettings,
            },
          },
  },
}));
    }
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          viewSettings,
        },
      },
    }));
  },
  getProgress: (key: string) => get().viewStates[key]?.progress || null,
  setProgress: (
    key: string,
    location: string,
    tocItem: TOCItem,
    section: PageInfo,
    pageinfo: PageInfo,
    timeinfo: TimeInfo,
    range: Range,
  ) =>
    set((state) => {
      const id = key.split('-')[0]!;
      const bookData = useBookDataStore.getState().booksData[id];
      const viewState = state.viewStates[key];
      if (!viewState || !bookData) return state;

      const pagePressInfo = bookData.isFixedLayout ? section : pageinfo;
      const progress: [number, number] = [pagePressInfo.current + 1, pagePressInfo.total];

      // Update library book progress
      const { library, setLibrary } = useLibraryStore.getState();
      const bookIndex = library.findIndex((b) => b.hash === id);
      if (bookIndex !== -1) {
        const updatedLibrary = [...library];
        const existingBook = updatedLibrary[bookIndex]!;
        updatedLibrary[bookIndex] = {
          ...existingBook,
          progress,
          updatedAt: Date.now(),
        };
        setLibrary(updatedLibrary);
      }

      const oldConfig = bookData.config;
      const newConfig = {
        ...bookData.config,
        progress,
        location,
      } as BookConfig;

      useBookDataStore.setState((state) => ({
        booksData: {
          ...state.booksData,
          [id]: {
            ...bookData,
            config: viewState.isPrimary ? newConfig : oldConfig,
          },
        },
      }));

      notifyFlutterAboutProgress(progress, bookData.book?.filePath);

      return {
        viewStates: {
          ...state.viewStates,
          [key]: {
            ...viewState,
            progress: {
              ...viewState.progress,
              location,
              sectionHref: tocItem?.href,
              sectionLabel: tocItem?.label,
              sectionId: tocItem?.id,
              section,
              pageinfo,
              timeinfo,
              range,
            },
          },
        },
      };
    }),
  setBookmarkRibbonVisibility: (key: string, visible: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          ribbonVisible: visible,
        },
      },
    })),

  setTTSEnabled: (key: string, enabled: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          ttsEnabled: enabled,
        },
      },
    })),

  setIsSyncing: (key: string, syncing: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          syncing,
        },
      },
    })),

  getGridInsets: (key: string) =>
    get().viewStates[key]?.gridInsets || { top: 0, right: 0, bottom: 0, left: 0 },
  setGridInsets: (key: string, insets: Insets | null) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          gridInsets: insets,
        },
      },
    })),

  setViewInited: (key: string, inited: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          inited,
        },
      },
    })),
}));
