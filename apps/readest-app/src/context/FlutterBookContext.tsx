'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Book, BookConfig } from '@/types/book';

// Extend Book interface to include file property for Flutter mode
interface FlutterBook extends Book {
  file?: File;
}

interface FlutterBookContent {
  book: FlutterBook;
  file: File;
  config: BookConfig;
}

interface FlutterBookContextType {
  isFlutterMode: boolean;
  flutterBook: FlutterBook | null;
  setFlutterBook: (book: FlutterBook | null) => void;
  getFlutterBookContent: () => FlutterBookContent | null;
  saveFlutterBookConfig: (config: BookConfig) => void;
}

const FlutterBookContext = createContext<FlutterBookContextType | undefined>(undefined);

interface FlutterBookProviderProps {
  children: React.ReactNode;
  isFlutterMode: boolean;
}

// Declare global types for Flutter integration
declare global {
  interface Window {
    __FLUTTER_BOOK_DATA__?: {
      book: FlutterBook;
      file?: File;
      bookId: string;
      isFlutterMode: boolean;
    };
    flutter_inappwebview?: {
      callHandler: (handlerName: string, data: any) => Promise<any>;
    };
  }

  interface WindowEventMap {
    'flutter-reader-ready': CustomEvent<{
      bookId: string;
      book: FlutterBook;
    }>;
  }
}

export function FlutterBookProvider({ children, isFlutterMode }: FlutterBookProviderProps) {
  const [flutterBook, setFlutterBook] = useState<FlutterBook | null>(null);

  useEffect(() => {
    if (isFlutterMode && typeof window !== 'undefined') {
      // Listen for Flutter reader ready event
      const handleReaderReady = (event: CustomEvent<{bookId: string; book: FlutterBook}>) => {
        const book = event.detail.book;
        setFlutterBook(book);
      };

      window.addEventListener('flutter-reader-ready', handleReaderReady);

      // Check if book data is already available
      const checkExistingData = () => {
        const bookData = window.__FLUTTER_BOOK_DATA__;
        if (bookData && bookData.book) {
          // Include file from global data if available
          const bookWithFile = {
            ...bookData.book,
            file: bookData.file || bookData.book.file
          };
          setFlutterBook(bookWithFile);
        }
      };

      // Use setTimeout to defer setState to avoid synchronous execution
      const timeoutId = setTimeout(checkExistingData, 0);

      return () => {
        window.removeEventListener('flutter-reader-ready', handleReaderReady);
        clearTimeout(timeoutId);
      };
    }

    return undefined;
  }, [isFlutterMode]);

  const getFlutterBookContent = (): FlutterBookContent | null => {
    if (!isFlutterMode || !flutterBook) return null;

    // If no file exists and there's a URL, let the Reader handle it directly
    // Don't create an empty file as it causes "File is empty" errors
    if (!flutterBook.file && flutterBook.url) {
      return null; // Let the Reader use the book.url instead
    }

    // Create a mock file only if we have actual file content
    const file = flutterBook.file || new File([''], flutterBook.title || 'book.pdf', { type: 'application/pdf' });

    return {
      book: flutterBook,
      file: file,
      config: {
        updatedAt: Date.now(),
        progress: flutterBook.progress || [1, 1],
        location: '',
        viewSettings: {},
        booknotes: []
      }
    };
  };

  const saveFlutterBookConfig = (config: BookConfig) => {
    if (isFlutterMode && typeof window !== 'undefined') {
      // Save via Flutter bridge
      if (window.flutter_inappwebview) {
        window.flutter_inappwebview.callHandler('saveBookConfig', {
          bookId: flutterBook?.hash,
          config,
          progress: config.progress
        }).catch((error) => {
          console.warn('Failed to save config via Flutter bridge:', error);
        });
      }

      // Update local state
      if (flutterBook) {
        setFlutterBook({
          ...flutterBook,
          progress: config.progress || flutterBook.progress,
          updatedAt: Date.now()
        });
      }
    }
  };

  const value = {
    isFlutterMode,
    flutterBook,
    setFlutterBook,
    getFlutterBookContent,
    saveFlutterBookConfig
  };

  return (
    <FlutterBookContext.Provider value={value}>
      {children}
    </FlutterBookContext.Provider>
  );
}

export function useFlutterBook() {
  const context = useContext(FlutterBookContext);
  if (context === undefined) {
    throw new Error('useFlutterBook must be used within a FlutterBookProvider');
  }
  return context;
}