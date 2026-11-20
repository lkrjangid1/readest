import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: vi.fn(() => false),
}));
vi.mock('@/utils/misc', () => ({ stubTranslation: (s: string) => s }));

import {
  flutterProvider,
  parseBridgeTranslations,
  toBridgeLang,
} from '@/services/translators/providers/flutter';
import { googleProvider } from '@/services/translators/providers/google';

type Handler = (name: string, data?: unknown) => Promise<unknown>;
const win = window as unknown as {
  flutter_inappwebview?: { callHandler: Handler };
};

describe('toBridgeLang', () => {
  it('maps reader codes to bridge codes', () => {
    expect(toBridgeLang('AUTO', 'auto')).toBe('auto');
    expect(toBridgeLang('', 'en')).toBe('en');
    expect(toBridgeLang('EN', 'en')).toBe('en');
    expect(toBridgeLang('pt-BR', 'en')).toBe('pt');
    expect(toBridgeLang('zh-TW', 'en')).toBe('zh-hant');
  });
});

describe('parseBridgeTranslations', () => {
  it('keeps strings and nulls out failures', () => {
    expect(parseBridgeTranslations({ translations: ['a', null, ' '] }, 3)).toEqual([
      'a',
      null,
      null,
    ]);
  });
  it('rejects a reply of the wrong shape', () => {
    expect(parseBridgeTranslations({ translations: ['a'] }, 2)).toBeNull();
    expect(parseBridgeTranslations(null, 1)).toBeNull();
    expect(parseBridgeTranslations({}, 1)).toBeNull();
  });
});

describe('flutterProvider', () => {
  let direct: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    direct = vi
      .spyOn(googleProvider, 'translate')
      .mockImplementation(async (texts: string[]) => texts.map((t) => `g:${t}`));
  });

  afterEach(() => {
    delete win.flutter_inappwebview;
    vi.restoreAllMocks();
  });

  it('translates through the Flutter bridge', async () => {
    const callHandler = vi.fn(async () => ({
      translations: ['Hola', 'Mundo'],
    }));
    win.flutter_inappwebview = { callHandler };
    const out = await flutterProvider.translate(['Hello', '', 'World'], 'AUTO', 'ES');
    expect(out).toEqual(['Hola', '', 'Mundo']);
    expect(callHandler).toHaveBeenCalledWith('translate', {
      texts: ['Hello', 'World'],
      from: 'auto',
      to: 'es',
    });
    expect(direct).not.toHaveBeenCalled();
  });

  it('falls back to direct Google for texts the bridge failed', async () => {
    win.flutter_inappwebview = {
      callHandler: vi.fn(async () => ({ translations: ['Hola', null] })),
    };
    const out = await flutterProvider.translate(['Hello', 'World'], 'AUTO', 'ES');
    expect(out).toEqual(['Hola', 'g:World']);
    expect(direct).toHaveBeenCalledWith(['World'], 'AUTO', 'ES');
  });

  it('falls back to direct Google without a bridge or when it throws', async () => {
    expect(await flutterProvider.translate(['Hello'], 'AUTO', 'ES')).toEqual(['g:Hello']);
    win.flutter_inappwebview = {
      callHandler: vi.fn(async () => {
        throw new Error('no handler');
      }),
    };
    expect(await flutterProvider.translate(['Hello'], 'AUTO', 'ES')).toEqual(['g:Hello']);
  });
});
