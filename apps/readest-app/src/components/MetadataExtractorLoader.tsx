'use client';

import { useEffect } from 'react';
// Static import to ensure the metadata extractor is always bundled
import '@/utils/metadataExtractor';

/**
 * Component to load and expose metadata extraction functionality
 * This ensures the metadataExtractor utility is bundled and available globally
 */
export default function MetadataExtractorLoader() {
  useEffect(() => {
    // Check if the metadata extractor was loaded
    if (typeof window !== 'undefined' && (window as any).__extractBookMetadata) {
      console.log('[MetadataExtractorLoader] Metadata extractor is available');
    } else {
      console.error('[MetadataExtractorLoader] Metadata extractor failed to load');
    }
  }, []);

  // This component renders nothing
  return null;
}
