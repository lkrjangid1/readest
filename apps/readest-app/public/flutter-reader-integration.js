/**
 * Flutter Reader Integration Layer
 * This script provides a bridge between Flutter InAppWebView and the Readest reader
 */

window.FlutterReaderAPI = {
  // Store for book data and settings
  bookCache: new Map(),
  currentBook: null,

  // Apply theme changes coming from Flutter
  applyTheme(theme = {}) {
    try {
      const validModes = ['auto', 'light', 'dark'];
      const mode = validModes.includes(theme.mode) ? theme.mode : localStorage.getItem('themeMode') || 'auto';
      const color = theme.color || localStorage.getItem('themeColor') || 'default';

      localStorage.setItem('themeMode', mode);
      localStorage.setItem('themeColor', color);

      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const isDark = mode === 'dark' || (mode === 'auto' && systemDark);
      document.documentElement.setAttribute('data-theme', `${color}-${isDark ? 'dark' : 'light'}`);

      if (window.__READestThemeBridge && typeof window.__READestThemeBridge.setTheme === 'function') {
        window.__READestThemeBridge.setTheme(mode, color);
      }
    } catch (error) {
      console.log('Failed to apply theme from Flutter:', error);
    }
  },

  // Initialize reader with file path
  async openBookFromPath(filePath, options = {}) {
    try {
      console.log('Opening book from path:', filePath);

      // Skip invalid or empty file paths
      if (!filePath || filePath.trim() === '' || filePath === 'read.html' || filePath.includes('read.html')) {
        console.log('Skipping invalid file path:', filePath);
        return { success: false, error: 'Invalid or empty file path' };
      }

      // For Flutter InAppWebView, we need to handle file loading differently
      let file;
      let fileName = filePath.split('/').pop() || 'unknown';

      // Try different methods to load the file
      if (window.flutter_inappwebview) {
        // Use Flutter bridge to read file
        try {
          const fileData = await window.flutter_inappwebview.callHandler('readBookFile', filePath);
          console.log(
            'Flutter bridge response metadata:',
            JSON.stringify({
              hasData: Boolean(fileData?.content),
              size: fileData?.size,
              success: fileData?.success,
              type: typeof fileData?.content,
              contentKeys:
                fileData?.content && typeof fileData.content === 'object'
                  ? Object.keys(fileData.content)
                  : null,
              isArray: Array.isArray(fileData?.content),
            }),
          );
          if (fileData?.content) {
            if (Array.isArray(fileData.content)) {
              console.log('Bridge content sample (array):', fileData.content.slice(0, 5));
            } else if (
              typeof fileData.content === 'object' &&
              fileData.content.data &&
              Array.isArray(fileData.content.data)
            ) {
              console.log('Bridge content sample (buffer):', fileData.content.data.slice(0, 5));
            } else if (typeof fileData.content === 'string') {
              console.log('Bridge content sample (base64 head):', fileData.content.slice(0, 16));
            }
          }
          if (fileData && fileData.content) {
            let bytes;
            if (Array.isArray(fileData.content)) {
              bytes = Uint8Array.from(fileData.content);
            } else if (
              typeof fileData.content === 'object' &&
              fileData.content.data &&
              Array.isArray(fileData.content.data)
            ) {
              // Handle Node-style Buffer { type: 'Buffer', data: [...] }
              bytes = Uint8Array.from(fileData.content.data);
            } else if (typeof fileData.content === 'string') {
              const binary = atob(fileData.content);
              bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
            } else if (fileData.content instanceof Uint8Array) {
              bytes = fileData.content;
            }

            if (bytes) {
              console.log('Creating File from bridge bytes:', bytes.length);
              file = new File([bytes], fileName, { type: this.getMimeType(fileName) });
            } else {
              console.warn('Unable to resolve byte content from Flutter bridge payload');
            }
          }
        } catch (error) {
          console.log('Flutter bridge file read failed, trying fetch method');
        }
      }

      // Fallback to fetch method
      if (!file) {
        try {
          const response = await fetch(`file://${filePath}`);
          if (response.ok) {
            file = await response.blob();
          }
        } catch (error) {
          console.log('Fetch method failed, trying direct file input');
        }
      }

      if (!file) {
        throw new Error('Unable to load file from any method');
      }

      const bookFile = file instanceof File ? file : new File([file], fileName, { type: this.getMimeType(fileName) });

      // Generate unique book ID
      const bookId = await this.generateBookId(bookFile);

      // Create book object
      const book = {
        hash: bookId,
        title: fileName.replace(/\.[^/.]+$/, ''),
        sourceTitle: fileName.replace(/\.[^/.]+$/, ''),
        format: this.getFileFormat(fileName),
        filePath: filePath,
        file: bookFile,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        progress: [1, 1],
        primaryLanguage: 'en',
        author: 'Unknown',
        ...options
      };

      // Cache the book
      this.bookCache.set(bookId, book);
      this.currentBook = book;

      // Initialize reader without full page reload
      await this.initializeReaderDynamic(bookId);

      const result = { success: true, bookId };
      console.log('openBookFromPath result:', JSON.stringify(result));
      return result;
    } catch (error) {
      console.error('Error opening book:', error);
      return { success: false, error: error.message };
    }
  },

  // Generate unique book ID from file content
  async generateBookId(file) {
    try {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer.slice(0, 1024));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    } catch (error) {
      // Fallback to simple hash based on filename and size
      const text = file.name + file.size + Date.now();
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return Math.abs(hash).toString(16).padStart(16, '0');
    }
  },

  // Get MIME type from extension
  getMimeType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes = {
      epub: 'application/epub+zip',
      pdf: 'application/pdf',
      mobi: 'application/x-mobipocket-ebook',
      azw3: 'application/vnd.amazon.ebook',
      fb2: 'application/x-fictionbook+xml',
      txt: 'text/plain'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  },

  // Get file format from extension
  getFileFormat(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const formats = {
      epub: 'epub',
      pdf: 'pdf',
      mobi: 'mobi',
      azw3: 'azw3',
      fb2: 'fb2',
      cbz: 'cbz',
      txt: 'txt'
    };
    return formats[ext] || 'unknown';
  },

  // Initialize the reader with book
  async initializeReader(bookId) {
    const book = this.bookCache.get(bookId);
    if (!book) {
      throw new Error('Book not found in cache');
    }

    // Wait for Next.js to initialize
    if (typeof window !== 'undefined') {
      let attempts = 0;
      while (typeof window.__NEXT_LOADED_PAGES__ === 'undefined' && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
    }

    // Inject book data into the page
    window.__FLUTTER_BOOK_DATA__ = {
      book,
      bookId,
      isFlutterMode: true
    };

    // Update URL params to match expected format
    if (window.history && window.location) {
      const url = new URL(window.location);
      url.searchParams.set('ids', bookId);
      window.history.replaceState({}, '', url);
    }

    // Trigger reader initialization
    this.notifyReaderReady();
  },

  // New method for dynamic reader initialization without page reload
  async initializeReaderDynamic(bookId) {
    const book = this.bookCache.get(bookId);
    if (!book) {
      throw new Error('Book not found in cache');
    }

    console.log('Initializing reader dynamically for book:', book.title);
    console.log('Book data:', JSON.stringify({ bookId, title: book.title, format: book.format, filePath: book.filePath }));

    // Wait for Next.js to initialize if needed
    if (typeof window !== 'undefined') {
      let attempts = 0;
      while (typeof window.__NEXT_LOADED_PAGES__ === 'undefined' && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      console.log('Next.js loaded after', attempts, 'attempts');
    }

    // Inject book data into the page
    window.__FLUTTER_BOOK_DATA__ = {
      book,
      bookId,
      isFlutterMode: true,
      isDynamicLoad: true
    };

    // Update URL params to match expected format
    if (window.history && window.location) {
      const url = new URL(window.location);
      url.searchParams.set('ids', bookId);
      url.searchParams.set('file', book.filePath);
      window.history.replaceState({}, '', url);
      console.log('Updated URL with bookId:', bookId, 'file:', book.filePath);
    }

    // Force a reload of the reader page component with new parameters
    if (typeof window !== 'undefined' && window.location) {
      // Trigger a route change event to force the reader to reload with new params
      const popStateEvent = new PopStateEvent('popstate', { state: {} });
      window.dispatchEvent(popStateEvent);
    }

    // Wait a bit for the route change to process
    await new Promise(resolve => setTimeout(resolve, 100));

    // Trigger reader update for dynamic loading
    this.notifyReaderUpdate();

    // Also trigger the traditional ready event for compatibility
    this.notifyReaderReady();
  },

  // Notify that reader should update with new book
  notifyReaderUpdate() {
    const event = new CustomEvent('flutter-reader-update', {
      detail: {
        bookId: this.currentBook?.hash,
        book: this.currentBook,
        isDynamicLoad: true
      }
    });
    window.dispatchEvent(event);
  },

  // Notify that reader is ready
  notifyReaderReady() {
    const event = new CustomEvent('flutter-reader-ready', {
      detail: {
        bookId: this.currentBook?.hash,
        book: this.currentBook
      }
    });
    window.dispatchEvent(event);
  },

  // Get current reading progress
  getProgress() {
    return this.currentBook?.progress || [1, 1];
  },

  // Set reading progress
  setProgress(progress) {
    if (this.currentBook) {
      this.currentBook.progress = progress;
      this.notifyProgressUpdate(progress);
    }
  },

  // Notify Flutter about progress updates
  notifyProgressUpdate(progress) {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('onProgressUpdate', {
        progress,
        bookId: this.currentBook?.hash
      }).catch(error => {
        console.log('Failed to notify Flutter about progress:', error);
      });
    }
  },

  // Save book configuration
  saveBookConfig(config) {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('saveBookConfig', {
        bookId: this.currentBook?.hash,
        config,
        progress: config.progress
      }).catch(error => {
        console.log('Failed to save book config to Flutter:', error);
      });
    }
  },

  // Close current book
  closeBook() {
    this.currentBook = null;
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('onBookClosed').catch(error => {
        console.log('Failed to notify Flutter about book close:', error);
      });
    }
  }
};

window.addEventListener('flutter-theme-changed', (event) => {
  try {
    window.FlutterReaderAPI.applyTheme(event.detail || {});
  } catch (error) {
    console.log('Failed to handle flutter-theme-changed event:', error);
  }
});

(() => {
  try {
    const mode = localStorage.getItem('themeMode');
    const color = localStorage.getItem('themeColor');
    if (mode || color) {
      window.FlutterReaderAPI.applyTheme({ mode, color });
    }
  } catch (error) {
    // ignore
  }
})();

// Notify listeners that the FlutterReaderAPI is ready for use
try {
  const event = new CustomEvent('flutter-reader-api-ready');
  window.dispatchEvent(event);
} catch (error) {
  console.warn('Failed to dispatch flutter-reader-api-ready event:', error);
}

// Handle URL routing for Flutter integration
(function() {
  if (typeof window === 'undefined') return;

  const path = window.location.pathname;
  const match = path.match(/^\/read\/(.+)$/);

  if (match) {
    const filePath = decodeURIComponent(match[1]);

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        window.FlutterReaderAPI.openBookFromPath(filePath);
      });
    } else {
      window.FlutterReaderAPI.openBookFromPath(filePath);
    }
  }
})();

// Override the default book loading for Flutter mode
window.__FLUTTER_OVERRIDE__ = {
  loadBookContent: async function(book, settings) {
    if (window.__FLUTTER_BOOK_DATA__ && window.__FLUTTER_BOOK_DATA__.book) {
      const flutterBook = window.__FLUTTER_BOOK_DATA__.book;
      return {
        book: flutterBook,
        file: flutterBook.file,
        config: {
          updatedAt: Date.now(),
          progress: flutterBook.progress,
          location: '',
          viewSettings: {},
          booknotes: []
        }
      };
    }
    return null;
  },

  saveBookConfig: async function(book, config, settings) {
    // Save to Flutter storage via bridge
    if (window.FlutterReaderAPI) {
      window.FlutterReaderAPI.saveBookConfig(config);
    }
    return true;
  }
};
