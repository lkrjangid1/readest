/**
 * Metadata Extractor for Flutter Integration
 * This module provides book metadata extraction functionality for the Flutter app
 */

import { DocumentLoader } from '@/libs/document';

export interface ExtractedMetadata {
  title: string;
  author: string;
  publisher?: string;
  isbn?: string;
  year?: string;
  description?: string;
  language?: string;
  format: string;
  coverBase64?: string;
  subtitle?: string;
  series?: string;
  seriesIndex?: number;
  editor?: string;
  subject?: string;
}

/**
 * Format metadata values from various formats to strings
 */
function formatValue(value: any): string | null {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (typeof value === 'object' && value !== null) {
    // Handle LanguageMap or Contributor objects
    if (value.name) return value.name;
    if (value.value) return value.value;
    // Try to get the first available value from object
    const values = Object.values(value);
    return values.length > 0 ? String(values[0]) : null;
  }
  return value ? String(value) : null;
}

/**
 * Extract metadata from a book file
 * @param file - The book file to extract metadata from
 * @param fileName - The name of the file
 * @returns Extracted metadata
 */
export async function extractBookMetadata(
  file: File,
  fileName: string
): Promise<{ success: boolean; metadata?: ExtractedMetadata; error?: string }> {
  try {
    console.log('[MetadataExtractor] Starting extraction for:', fileName);

    // Open the book and extract metadata
    const loader = new DocumentLoader(file);
    const { book, format } = await loader.open();

    if (!book || !book.metadata) {
      return { success: false, error: 'Failed to parse book' };
    }

    const metadata = book.metadata;

    // Extract cover image as base64 if available
    let coverBase64: string | undefined;
    try {
      const coverBlob = await book.getCover();
      if (coverBlob) {
        coverBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(coverBlob);
        });
      }
    } catch (coverError) {
      console.warn('[MetadataExtractor] Failed to extract cover:', coverError);
    }

    // Build the metadata response
    const result: ExtractedMetadata = {
      title: formatValue(metadata.title) || fileName.replace(/\.[^/.]+$/, ''),
      author: formatValue(metadata.author) || 'Unknown Author',
      publisher: formatValue(metadata.publisher) || undefined,
      isbn: formatValue(metadata.identifier || metadata.altIdentifier) || undefined,
      year: formatValue(metadata.published) || undefined,
      description: formatValue(metadata.description) || undefined,
      language: formatValue(metadata.language) || undefined,
      format: format,
      coverBase64,
      subtitle: formatValue(metadata.subtitle) || undefined,
      series: formatValue(metadata.series) || undefined,
      seriesIndex: metadata.seriesIndex,
      editor: formatValue(metadata.editor) || undefined,
      subject: formatValue(metadata.subject) || undefined,
    };

    console.log('[MetadataExtractor] Extraction successful:', result.title);
    return { success: true, metadata: result };
  } catch (error: any) {
    console.error('[MetadataExtractor] Extraction error:', error);
    return {
      success: false,
      error: error.message || 'Unknown error',
    };
  }
}

// Expose to window for Flutter integration
if (typeof window !== 'undefined') {
  (window as any).__extractBookMetadata = extractBookMetadata;
}
