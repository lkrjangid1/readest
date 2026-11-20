import { isFlutterHost } from '@/utils/flutterHost';
import { TranslationProvider } from '../types';
import { deeplProvider } from './deepl';
import { azureProvider } from './azure';
import { googleProvider } from './google';
import { yandexProvider } from './yandex';
import { flutterProvider } from './flutter';

function createTranslator<T extends string>(
  name: T,
  implementation: TranslationProvider,
): TranslationProvider & { name: T } {
  if (name !== implementation.name) {
    throw Error(
      `Translator name "${name}" does not match implementation name "${implementation.name}"`,
    );
  }
  return implementation as TranslationProvider & { name: T };
}

const deeplTranslator = createTranslator('deepl', deeplProvider);
const azureTranslator = createTranslator('azure', azureProvider);
const googleTranslator = createTranslator('google', googleProvider);
const yandexTranslator = createTranslator('yandex', yandexProvider);
const flutterTranslator = createTranslator('flutter', flutterProvider);

const availableTranslators = [
  deeplTranslator,
  azureTranslator,
  googleTranslator,
  yandexTranslator,
  flutterTranslator,
  // Add more translators here
];

export type TranslatorName = (typeof availableTranslators)[number]['name'];

/**
 * Providers offered inside the Flutter app: no Readest account there (DeepL
 * needs one) and the Edge token endpoint Azure relies on is gone. The app
 * translates natively through its `translate` bridge handler (the
 * `translator` package), falling back to the keyless Google endpoints.
 */
export const EMBEDDED_TRANSLATORS: TranslatorName[] = ['flutter'];

/** Only works with the Flutter bridge: never listed elsewhere. */
const FLUTTER_ONLY_TRANSLATORS: TranslatorName[] = ['flutter'];

const listedTranslators = () =>
  isFlutterHost()
    ? availableTranslators.filter((t) => EMBEDDED_TRANSLATORS.includes(t.name))
    : availableTranslators.filter((t) => !FLUTTER_ONLY_TRANSLATORS.includes(t.name));

export const getTranslator = (name: TranslatorName): TranslationProvider | undefined => {
  return listedTranslators().find((translator) => translator.name === name);
};

export const getTranslators = (): TranslationProvider[] => {
  return listedTranslators();
};

/** The provider to use for [name]: itself when usable, else the first usable one. */
export const resolveTranslatorName = (
  name: string | undefined,
  hasToken: boolean,
): TranslatorName | undefined => {
  const usable = getTranslators().filter((t) => isTranslatorAvailable(t, hasToken));
  return (usable.find((t) => t.name === name) ?? usable[0])?.name as TranslatorName | undefined;
};

/**
 * Single source of truth for "can this provider actually be used right now?".
 * Used by auto-selection / fallback logic in `useTranslator`, the settings
 * panel, and the translator popup. Disabled providers (e.g. temporarily down
 * upstream services) are still returned from `getTranslators()` so the UI can
 * render them greyed out, but this predicate excludes them so they can never
 * be chosen or fallen back to.
 */
export const isTranslatorAvailable = (
  translator: TranslationProvider,
  hasToken: boolean,
): boolean => {
  if (translator.disabled) return false;
  if (translator.quotaExceeded) return false;
  if (translator.authRequired && !hasToken) return false;
  return true;
};

/**
 * Builds the user-facing dropdown label for a provider, appending a short
 * status suffix when the provider is unavailable. Kept next to
 * `isTranslatorAvailable` so the two stay in sync when a new unavailability
 * reason is added. The `_` translation function is passed in so this module
 * stays free of React imports.
 */
export const getTranslatorDisplayLabel = (
  translator: TranslationProvider,
  hasToken: boolean,
  _: (key: string) => string,
): string => {
  if (translator.disabled) {
    return `${translator.label}`;
  }
  if (translator.authRequired && !hasToken) {
    return `${translator.label} (${_('Login Required')})`;
  }
  if (translator.quotaExceeded) {
    return `${translator.label} (${_('Quota Exceeded')})`;
  }
  return translator.label;
};
