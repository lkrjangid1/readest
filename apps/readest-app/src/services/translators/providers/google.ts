import { stubTranslation as _ } from '@/utils/misc';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { normalizeToShortLang } from '@/utils/lang';
import { TranslationProvider } from '../types';

const gtxUrl = (q: string, sl: string, tl: string) => {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.append('client', 'gtx');
  url.searchParams.append('dt', 't');
  url.searchParams.append('sl', sl);
  url.searchParams.append('tl', tl);
  url.searchParams.append('q', q);
  return url.toString();
};

const dictExtUrl = (q: string, sl: string, tl: string) => {
  const url = new URL('https://clients5.google.com/translate_a/t');
  url.searchParams.append('client', 'dict-chrome-ex');
  url.searchParams.append('sl', sl);
  url.searchParams.append('tl', tl);
  url.searchParams.append('q', q);
  return url.toString();
};

/** `[[["Hola","Hello",…],…],…]` → "Hola…" */
export const parseGtxResponse = (data: unknown): string | null => {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  return (
    (data[0] as unknown[])
      .filter((segment): segment is string[] => Array.isArray(segment) && !!segment[0])
      .map((segment) => segment[0])
      .join('') || null
  );
};

/** `["Hola"]` (source given) or `[["Hola","en"]]` (auto-detected) → "Hola" */
export const parseDictExtResponse = (data: unknown): string | null => {
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (typeof first === 'string') return first || null;
  if (Array.isArray(first) && typeof first[0] === 'string') return first[0] || null;
  return null;
};

export const googleProvider: TranslationProvider = {
  name: 'google',
  label: _('Google Translate'),
  translate: async (text: string[], sourceLang: string, targetLang: string): Promise<string[]> => {
    if (!text.length) return [];

    const results: string[] = [];

    const translationPromises = text.map(async (line, index) => {
      if (!line?.trim().length) {
        results[index] = line;
        return;
      }

      const sl = normalizeToShortLang(sourceLang).toLowerCase() || 'auto';
      const tl = normalizeToShortLang(targetLang).toLowerCase();
      const fetch = isTauriAppPlatform() ? tauriFetch : window.fetch;

      let translatedText: string | null = null;
      let failure: unknown = null;
      try {
        const response = await fetch(gtxUrl(line, sl, tl));
        if (!response.ok) throw new Error(`Translation failed with status ${response.status}`);
        translatedText = parseGtxResponse(await response.json());
      } catch (error) {
        failure = error;
      }
      // The gtx endpoint rate-limits shared IPs (HTTP 429); the dictionary
      // extension endpoint is keyless too and still answers.
      if (failure) {
        const response = await fetch(dictExtUrl(line, sl, tl));
        if (!response.ok) throw failure;
        translatedText = parseDictExtResponse(await response.json());
      }
      results[index] = translatedText || line;
    });

    await Promise.all(translationPromises);

    return results;
  },
};
