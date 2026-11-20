import { stubTranslation as _ } from '@/utils/misc';
import { flutterHost } from '@/utils/flutterHost';
import { normalizeToShortLang } from '@/utils/lang';
import { TranslationProvider } from '../types';
import { googleProvider } from './google';

/**
 * Translation inside the Flutter app: the `translate` bridge handler runs the
 * `translator` package natively, outside the WebView, so it is not hit by the
 * WebView's rate limits on Google's keyless endpoints.
 *
 * JS → Flutter: callHandler `translate` {texts, from, to} → {translations}
 * where each entry is a string or null (that text failed).
 * Texts the bridge can't translate (no bridge, a failed call, a null entry)
 * fall back to the direct Google provider.
 */

type BridgeResult = { translations?: unknown } | null | undefined;

/** Reader codes ('AUTO', 'EN', 'zh-Hant', 'pt-BR') → bridge codes. */
export const toBridgeLang = (lang: string, fallback: string): string => {
  const code = (lang || '').trim();
  if (!code || code.toUpperCase() === 'AUTO') return fallback;
  return normalizeToShortLang(code).toLowerCase() || fallback;
};

/** The bridge's `translations`, or null when the reply is unusable. */
export const parseBridgeTranslations = (
  data: BridgeResult,
  count: number,
): (string | null)[] | null => {
  const list = data?.translations;
  if (!Array.isArray(list) || list.length !== count) return null;
  return list.map((t) => (typeof t === 'string' && t.trim() ? t : null));
};

const BRIDGE_TIMEOUT_MS = 20000;

const callBridge = async (
  texts: string[],
  from: string,
  to: string,
): Promise<(string | null)[] | null> => {
  const host = flutterHost();
  if (!host) return null;
  try {
    const reply = await Promise.race([
      host.callHandler('translate', { texts, from, to }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)),
    ]);
    return parseBridgeTranslations(reply as BridgeResult, texts.length);
  } catch (error) {
    console.warn('Flutter translate failed:', error);
    return null;
  }
};

export const flutterProvider: TranslationProvider = {
  name: 'flutter',
  label: _('Google Translate'),
  translate: async (text: string[], sourceLang: string, targetLang: string): Promise<string[]> => {
    if (!text.length) return [];
    const results = [...text];
    const pending: number[] = [];
    text.forEach((line, index) => {
      if (line?.trim().length) pending.push(index);
    });
    if (!pending.length) return results;

    const from = toBridgeLang(sourceLang, 'auto');
    const to = toBridgeLang(targetLang, 'en');
    const bridged = await callBridge(
      pending.map((i) => text[i]!),
      from,
      to,
    );

    const missing: number[] = [];
    pending.forEach((index, k) => {
      const translated = bridged?.[k];
      if (translated) results[index] = translated;
      else missing.push(index);
    });
    if (!missing.length) return results;

    // No bridge, or some texts failed there: the direct endpoints.
    const direct = await googleProvider.translate(
      missing.map((i) => text[i]!),
      sourceLang,
      targetLang,
    );
    missing.forEach((index, k) => {
      results[index] = direct[k] || text[index]!;
    });
    return results;
  },
};
