import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { EnvProvider } from '@/context/EnvContext';
import { CSPostHogProvider } from '@/context/PHContext';
import { SyncProvider } from '@/context/SyncContext';
import Reader from '@/app/reader/components/Reader';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { Book } from '@/types/book';

const DEFAULT_FILE_SERVER_PORT = '6391';

const isRemoteUrl = (path: string) => /^https?:\/\//i.test(path);
const isFileProtocol = (path: string) => path.startsWith('file://') || path.startsWith('content://');
const normalizePath = (value?: string | string[] | null) => {
  if (!value) return '';
  const raw = (Array.isArray(value) ? value[0] : value) ?? '';
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
};

const parseFileParam = (routerQuery: Record<string, string | string[] | undefined>) => {
  let filePath = normalizePath(routerQuery['file']);
  if (!filePath && typeof window !== 'undefined') {
    const currentUrl = new URL(window.location.href);
    filePath = normalizePath(currentUrl.searchParams.get('file') || currentUrl.searchParams.get('path'));
    if (!filePath) {
      const encodedMatch = currentUrl.href.match(/read\.html%3Ffile=([^&]*)/);
      if (encodedMatch?.[1]) {
        filePath = normalizePath(encodedMatch[1]);
      }
    }
  }
  return filePath;
};

const parseBookIdParam = (routerQuery: Record<string, string | string[] | undefined>) => {
  return (
    normalizePath(routerQuery['book']) ||
    normalizePath(routerQuery['bookId']) ||
    normalizePath(routerQuery['id'])
  );
};

const buildImportSource = (filePath: string) => {
  if (!filePath) return '';
  if (isRemoteUrl(filePath) || isFileProtocol(filePath)) {
    return filePath;
  }
  if (typeof window === 'undefined') return filePath;
  const fileName = filePath.split(/[\\/]/).pop() || `book-${Date.now()}`;
  const port = window.location.port || DEFAULT_FILE_SERVER_PORT;
  return `http://127.0.0.1:${port}/${encodeURIComponent(fileName)}`;
};

const tryMatchBookByFilename = (library: Book[], filePath: string) => {
  if (!filePath) return null;
  const fileName = filePath.split(/[\\/]/).pop();
  if (!fileName) return null;
  const baseName = fileName.replace(/\.[^/.]+$/, '').toLowerCase();
  return (
    library.find((book) => book.hash === filePath) ||
    library.find((book) => book.title?.toLowerCase() === baseName) ||
    library.find((book) => book.sourceTitle?.toLowerCase() === baseName)
  );
};

function ReadEntryContent() {
  const router = useRouter();
  const { appService } = useEnv();
  const [bookId, setBookId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);

  const ensureLibraryLoaded = useCallback(async () => {
    let current = useLibraryStore.getState().library;
    if ((!current || current.length === 0) && appService) {
      current = await appService.loadLibraryBooks();
      useLibraryStore.getState().setLibrary(current);
    }
    return current;
  }, [appService]);

  const loadBookById = useCallback(
    async (hash: string) => {
      const library = await ensureLibraryLoaded();
      const existing = library.find((book) => book.hash === hash);
      if (existing) {
        return existing;
      }
      if (appService) {
        const refreshed = await appService.loadLibraryBooks();
        useLibraryStore.getState().setLibrary(refreshed);
        return refreshed.find((book) => book.hash === hash) || null;
      }
      return null;
    },
    [appService, ensureLibraryLoaded],
  );

  const importFromPath = useCallback(
    async (filePath: string) => {
      if (!appService) {
        throw new Error('Application service is not available yet.');
      }
      const normalizedPath = normalizePath(filePath);
      const library = await ensureLibraryLoaded();
      const existing = tryMatchBookByFilename(library, normalizedPath);
      if (existing) {
        return existing;
      }

      const importSource = buildImportSource(normalizedPath);
      if (!importSource) throw new Error('Invalid file path provided.');

      const imported = await appService.importBook(importSource, library, true, true, false, false);
      if (!imported) {
        throw new Error('Failed to import the requested book.');
      }

      await appService.saveLibraryBooks(library);
      useLibraryStore.getState().setLibrary([...library]);
      return imported;
    },
    [appService, ensureLibraryLoaded],
  );

  const parsedQueries = useMemo(() => {
    return {
      file: parseFileParam(router.query),
      bookId: parseBookIdParam(router.query),
    };
  }, [router.query]);

  useEffect(() => {
    if (!router.isReady || isImporting || hasHydrated) return;
    if (!appService) return;

    const run = async () => {
      setIsImporting(true);
      setError(null);
      try {
        let targetBook: Book | null = null;

        if (parsedQueries.bookId) {
          targetBook = (await loadBookById(parsedQueries.bookId)) as Book | null;
          if (!targetBook) {
            throw new Error(`No book found with id "${parsedQueries.bookId}".`);
          }
        }

        if (!targetBook) {
          if (!parsedQueries.file) {
            throw new Error('Provide either a book hash (?book=) or a file path (?file=).');
          }
          targetBook = await importFromPath(parsedQueries.file);
        }

        if (!targetBook) {
          throw new Error('Unable to locate or import the requested book.');
        }

        setBookId(targetBook.hash);
        setHasHydrated(true);
      } catch (err) {
        console.error('Failed to prepare reader entry:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsImporting(false);
      }
    };

    run();
  }, [
    router.isReady,
    parsedQueries.bookId,
    parsedQueries.file,
    appService,
    loadBookById,
    importFromPath,
    hasHydrated,
    isImporting,
  ]);

  useEffect(() => {
    const handleDynamicUpdate = (event: CustomEvent) => {
      const { bookId: newBookId, isDynamicLoad } = event.detail || {};
      if (isDynamicLoad && newBookId) {
        setBookId(newBookId);
        setHasHydrated(true);
        setIsImporting(false);
        setError(null);
      }
    };
    const handlePopState = () => {
      setHasHydrated(false);
      setIsImporting(false);
      setError(null);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('flutter-reader-update', handleDynamicUpdate as EventListener);
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('flutter-reader-update', handleDynamicUpdate as EventListener);
        window.removeEventListener('popstate', handlePopState);
      };
    }
    return undefined;
  }, []);

  if (isImporting || error || !bookId) {
    return (
      <div className='flex min-h-screen items-center justify-center'>
        <div className='text-center'>
          <div className='mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600'></div>
        </div>
      </div>
    );
  }

  return <Reader ids={bookId} />;
}

export default function DirectReadPage() {
  return (
    <CSPostHogProvider>
      <EnvProvider>
        <AuthProvider>
          <SyncProvider>
            <ReadEntryContent />
          </SyncProvider>
        </AuthProvider>
      </EnvProvider>
    </CSPostHogProvider>
  );
}
