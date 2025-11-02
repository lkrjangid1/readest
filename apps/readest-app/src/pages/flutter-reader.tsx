import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AuthProvider } from '@/context/AuthContext';
import { EnvProvider } from '@/context/EnvContext';
import { CSPostHogProvider } from '@/context/PHContext';
import { SyncProvider } from '@/context/SyncContext';
import Reader from '@/app/reader/components/Reader';
import { FlutterBookProvider } from '@/context/FlutterBookContext';

export default function FlutterReaderTestPage() {
  const router = useRouter();
  const [bookId, setBookId] = useState<string | null>(null);
  const [isFlutterMode, setIsFlutterMode] = useState(false);

  useEffect(() => {
    // Get file path from query parameter
    const filePathParam = router.query['file'] as string;

    if (filePathParam) {
      // Use setTimeout to defer setState to avoid synchronous execution
      const initializeFlutterMode = () => {
        setIsFlutterMode(true);

        // For testing purposes, simulate successful book loading
        console.log('Loading book from path:', filePathParam);

        // Simulate book ID generation for testing
        const simulatedBookId = `book_${Date.now()}`;
        setBookId(simulatedBookId);

        // Initialize Flutter Reader API if available
        if (typeof window !== 'undefined') {
          (window as any).FlutterReaderAPI?.openBookFromPath(filePathParam)
            .then((result: any) => {
              if (result.success) {
                setBookId(result.bookId);
              }
            })
            .catch((error: any) => {
              console.warn('Flutter API not available, using simulation:', error);
            });
        }
      };

      const timeoutId = setTimeout(initializeFlutterMode, 0);
      return () => clearTimeout(timeoutId);
    }

    return undefined;
  }, [router.query['file']]);

  // Show loading until book is ready
  if (isFlutterMode && !bookId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p>Loading book from: {router.query['file']}</p>
        </div>
      </div>
    );
  }

  // Show file input if no file specified
  if (!router.query['file']) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Flutter Reader Test</h1>
          <p className="mb-4">Add ?file=YOUR_FILE_PATH to the URL to test</p>
          <p className="text-sm text-gray-600">
            Example: /flutter-reader?file=/path/to/your/file.pdf
          </p>
        </div>
      </div>
    );
  }

  return (
    <CSPostHogProvider>
      <EnvProvider>
        <AuthProvider>
          <SyncProvider>
            <FlutterBookProvider isFlutterMode={isFlutterMode}>
              <div className="min-h-screen bg-gray-100">
                <div className="p-4">
                  <h2 className="text-xl font-bold mb-4">Flutter Reader Test Mode</h2>
                  <p className="mb-4">File: {router.query['file']}</p>
                  <p className="mb-4">Book ID: {bookId}</p>
                </div>
                <Reader ids={bookId || ''} />
              </div>
            </FlutterBookProvider>
          </SyncProvider>
        </AuthProvider>
      </EnvProvider>
    </CSPostHogProvider>
  );
}