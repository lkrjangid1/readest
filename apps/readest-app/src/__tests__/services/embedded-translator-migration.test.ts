import { describe, expect, it } from 'vitest';
import { migrateEmbeddedTranslator } from '@/services/settingsService';
import type { SystemSettings } from '@/types/settings';

const settingsWith = (read: object, view: object) =>
  ({ globalReadSettings: read, globalViewSettings: view }) as unknown as SystemSettings;

describe('migrateEmbeddedTranslator', () => {
  it('moves the old DeepL default to Google in the app language', () => {
    const s = settingsWith(
      { translationProvider: 'deepl', translateTargetLang: 'EN' },
      { translationProvider: 'deepl' },
    );
    migrateEmbeddedTranslator(s);
    expect(s.globalReadSettings.translationProvider).toBe('google');
    expect(s.globalReadSettings.translateTargetLang).toBe('');
    expect(s.globalViewSettings.translationProvider).toBe('google');
  });

  it('keeps a chosen target language and a non-DeepL provider', () => {
    const s = settingsWith(
      { translationProvider: 'deepl', translateTargetLang: 'ES' },
      { translationProvider: 'google' },
    );
    migrateEmbeddedTranslator(s);
    expect(s.globalReadSettings.translateTargetLang).toBe('ES');

    const t = settingsWith(
      { translationProvider: 'google', translateTargetLang: 'EN' },
      { translationProvider: 'google' },
    );
    migrateEmbeddedTranslator(t);
    expect(t.globalReadSettings.translateTargetLang).toBe('EN');
  });
});
