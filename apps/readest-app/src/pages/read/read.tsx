import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { EnvProvider } from '@/context/EnvContext';
import { CSPostHogProvider } from '@/context/PHContext';
import { SyncProvider } from '@/context/SyncContext';
import Reader from '@/app/reader/components/Reader';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';

async function waitForFlutterApi(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if ((window as any).FlutterReaderAPI) return true;

  return await new Promise<boolean>((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      window.removeEventListener('flutter-reader-api-ready', onReady);
    };

    const onReady = () => {
      cleanup();
      resolve(true);
    };

    window.addEventListener('flutter-reader-api-ready', onReady, { once: true });
    timeoutId = setTimeout(() => {
      cleanup();
      resolve(Boolean((window as any).FlutterReaderAPI));
    }, 2000);
  });
}

function FlutterReaderContent() {
  const router = useRouter();
  const { appService } = useEnv();
  const { library: libraryBooks } = useLibraryStore();
  const [bookId, setBookId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasImported, setHasImported] = useState(false);

  useEffect(() => {
    // Prevent multiple imports
    if (hasImported || isImporting) return;

    const importAndLoadBook = async () => {
      // Get file path from query parameter - handle both normal and double-encoded URLs
      let filePathParam = router.query['file'] as string;

      // If router.query doesn't have the file param, try parsing from window.location manually
      if (!filePathParam && typeof window !== 'undefined') {
        const currentUrl = window.location.href;
        console.log('Current URL:', currentUrl);

        // Handle double-encoded URLs like read.html%3Ffile=%2Fstorage...
        const doubleEncodedMatch = currentUrl.match(/read\.html%3Ffile=([^&]*)/);
        if (doubleEncodedMatch && doubleEncodedMatch[1]) {
          filePathParam = decodeURIComponent(doubleEncodedMatch[1]);
          console.log('Found double-encoded file param:', filePathParam);
        } else {
          // Try normal URL parsing
          const url = new URL(currentUrl);
          filePathParam = url.searchParams.get('file') || '';
          console.log('Found normal file param:', filePathParam);
        }
      }

      let filePath = '';

      // Use query parameter 'file' for file path
      if (filePathParam) {
        filePath = decodeURIComponent(filePathParam);
      }

      console.log('Raw query parameter:', router.query['file']);
      console.log('Manual URL parsing result:', filePathParam);
      console.log('Final decoded file path:', filePath);
      console.log('App service available:', !!appService);

      if (!filePath || !appService) {
        console.log('Missing filePath or appService, returning early');
        return;
      }

      const flutterData = typeof window !== 'undefined' ? (window as any).__FLUTTER_BOOK_DATA__ : null;
      if (flutterData?.isFlutterMode && flutterData.book?.hash) {
        console.log('Flutter mode detected with existing book data:', flutterData.book.hash);
        setBookId(flutterData.book.hash);
        setHasImported(true);
        return;
      }

      let isFlutterMode = false;
      if (typeof window !== 'undefined') {
        isFlutterMode = await waitForFlutterApi();
        console.log('Flutter Reader API ready:', isFlutterMode);
      }

      // Check if book is already imported
      const fileName = filePath.split('/').pop() || 'book.pdf';
      const currentPort = window.location.port || '6391';
      const httpUrl = `http://127.0.0.1:${currentPort}/${encodeURIComponent(fileName)}`;
      const existingBook = libraryBooks.find(book =>
        book.title === fileName ||
        book.sourceTitle === fileName ||
        book.filePath === filePath ||
        book.url === httpUrl ||
        (book.url && book.url.includes(fileName))
      );

      if (existingBook) {
        console.log('Book already exists in library:', existingBook.title);
        setBookId(existingBook.hash);
        setHasImported(true);
        return;
      }

      if (isFlutterMode) {
        console.log('Flutter mode active - opening book via FlutterReaderAPI');
        try {
          const response = await (window as any).FlutterReaderAPI.openBookFromPath(filePath);
          if (response?.success && response.bookId) {
            console.log('FlutterReaderAPI opened book successfully with id:', response.bookId);
            setBookId(response.bookId);
            setHasImported(true);
            return;
          } else {
            throw new Error(response?.error || 'Unknown FlutterReaderAPI error');
          }
        } catch (flutterError) {
          console.error('FlutterReaderAPI failed to open book:', flutterError);
          setError(flutterError instanceof Error ? flutterError.message : String(flutterError));
          setIsImporting(false);
          return;
        }
      }

      setIsImporting(true);
      console.log('Importing book from path:', filePath);

      // Declare importPath outside try block for error handling
      let importPath = filePath;

      try {
        // For local file paths, convert to HTTP URL
        if (filePath.startsWith('/')) {
          const encodedFileName = encodeURIComponent(fileName);

          // Detect platform and use appropriate CORS server
          const isAndroid = filePath.includes('/storage/emulated') || filePath.includes('/sdcard') || filePath.includes('/data/user/0/com.yaaratech.libgen');

          if (isAndroid) {
            // For Android, use a specific CORS server port for file serving
            importPath = `http://127.0.0.1:6391/${encodedFileName}`;
            console.log('Android file detected, using CORS server:', importPath);
          } else {
            // For desktop/web, use the file serving port
            importPath = `http://127.0.0.1:6391/${encodedFileName}`;
            console.log('Desktop file detected, using file server:', importPath);
          }
        }

        // Use the native importBook method - get fresh library state
        const currentLibrary = useLibraryStore.getState().library;
        console.log('Calling appService.importBook with URL:', importPath);
        const book = await appService.importBook(importPath, currentLibrary, true, true, false, true);

        if (book) {
          console.log('Book imported successfully:', book.title, 'Hash:', book.hash);

          // Save the updated library to file system (importBook modifies in-memory array but doesn't persist)
          await appService.saveLibraryBooks(currentLibrary);
          console.log('Library saved to file system');

          // Reload library from file system to update the store
          const freshLibrary = await appService.loadLibraryBooks();
          useLibraryStore.getState().setLibrary(freshLibrary);
          console.log('Library refreshed with', freshLibrary.length, 'books');

          // Verify the book exists in the refreshed library
          const bookExists = freshLibrary.find(b => b.hash === book.hash);
          if (!bookExists) {
            console.error('Book not found in library! Looking for hash:', book.hash);
            console.error('Available books:', freshLibrary.map(b => ({ hash: b.hash, title: b.title })));
            throw new Error(`Book with hash ${book.hash} not found in refreshed library`);
          }
          console.log('Book verified in library:', bookExists.title);

          setBookId(book.hash);
          setHasImported(true);
        } else {
          throw new Error('Failed to import book - importBook returned null');
        }
      } catch (error) {
        console.error('Error importing book:', error);
        console.error('Import path was:', importPath);
        console.error('Original file path:', filePath);

        // More specific error handling
        let errorMessage = 'Unknown error occurred';
        if (error instanceof Error) {
          errorMessage = error.message;
          if (error.message.includes('Failed to fetch')) {
            errorMessage = `Network error: Cannot access file server. Make sure CORS server is running and accessible.`;
          }
        }

        setError(errorMessage);
      } finally {
        setIsImporting(false);
      }
    };

    importAndLoadBook();
  }, [router.query['file'], appService, hasImported, isImporting, libraryBooks]);

  // Handle dynamic book updates from JavaScript bridge
  useEffect(() => {
    const handleDynamicUpdate = (event: any) => {
      console.log('Read page received flutter-reader-update event:', event.detail);
      const { bookId: newBookId, isDynamicLoad } = event.detail;

      if (isDynamicLoad && newBookId && newBookId !== bookId) {
        console.log('Setting new bookId from dynamic update:', newBookId);
        setBookId(newBookId);
        setHasImported(true);
        setIsImporting(false);
        setError(null);
      }
    };

    const handlePopState = () => {
      console.log('PopState event detected, resetting import state');
      setHasImported(false);
      setIsImporting(false);
      setError(null);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('flutter-reader-update', handleDynamicUpdate);
      window.addEventListener('popstate', handlePopState);

      return () => {
        window.removeEventListener('flutter-reader-update', handleDynamicUpdate);
        window.removeEventListener('popstate', handlePopState);
      };
    }

    return undefined;
  }, [bookId]);

  // Show loading while importing
  if (isImporting) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p>Importing book...</p>
          <p className="text-sm text-gray-600 mt-2">
            File: {router.query['file']}
          </p>
        </div>
      </div>
    );
  }

  // Show error if import failed
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="text-red-600 text-xl mb-4">❌</div>
          <p className="text-red-600">Import Error: {error}</p>
          <p className="text-sm text-gray-600 mt-2">
            File: {router.query['file']}
          </p>
          <button
            onClick={() => router.back()}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  // Show loading until book is ready
  if (!bookId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p>Preparing reader...</p>
        </div>
      </div>
    );
  }

  // Render the actual reader
  return <Reader ids={bookId} />;
}

export default function FlutterReaderPage() {
  return (
    <CSPostHogProvider>
      <EnvProvider>
        <AuthProvider>
          <SyncProvider>
            <FlutterReaderContent />
          </SyncProvider>
        </AuthProvider>
      </EnvProvider>
    </CSPostHogProvider>
  );
}