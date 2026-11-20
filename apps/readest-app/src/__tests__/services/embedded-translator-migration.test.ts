import { describe, expect, it } from 'vitest';
import { migrateEmbeddedTranslator } from '@/services/settingsService';
import type { SystemSettings } from '@/types/settings';

const settingsWith = (read: object, view: object) =>
  ({ globalReadSettings: read, globalViewSettings: view }) as unknown as SystemSettings;

describe('migrateEmbeddedTranslator', () => {
  it('moves the old DeepL default to the app translator in the app language', () => {
    const s = settingsWith(
      { translationProvider: 'deepl', translateTargetLang: 'EN' },
      { translationProvider: 'deepl' },
    );
    migrateEmbeddedTranslator(s);
    expect(s.globalReadSettings.translationProvider).toBe('flutter');
    expect(s.globalReadSettings.translateTargetLang).toBe('');
    expect(s.globalViewSettings.translationProvider).toBe('flutter');
  });

  it('moves direct Google to the app translator', () => {
    const s = settingsWith(
      { translationProvider: 'google', translateTargetLang: 'EN' },
      { translationProvider: 'google' },
    );
    migrateEmbeddedTranslator(s);
    expect(s.globalReadSettings.translationProvider).toBe('flutter');
    expect(s.globalViewSettings.translationProvider).toBe('flutter');
    // Only the DeepL default's target is reset.
    expect(s.globalReadSettings.translateTargetLang).toBe('EN');
  });

  it('keeps a chosen target language', () => {
    const s = settingsWith(
      { translationProvider: 'deepl', translateTargetLang: 'ES' },
      { translationProvider: 'flutter' },
    );
    migrateEmbeddedTranslator(s);
    expect(s.globalReadSettings.translateTargetLang).toBe('ES');
    expect(s.globalViewSettings.translationProvider).toBe('flutter');
  });
});
