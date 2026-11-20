import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/services/tts/TTSController', () => ({ TTSController: class {} }));

import { FlutterTTSClient, toTTSMessage } from '@/services/tts/FlutterTTSClient';
import type { TTSMessageEvent } from '@/services/tts/TTSClient';

type Handler = (name: string, data?: unknown) => Promise<unknown>;
type Win = {
  flutter_inappwebview?: { callHandler: Handler };
  __flutterTTSEvent?: (e: unknown) => void;
};
const win = window as unknown as Win;

// Node 25's experimental localStorage global shadows jsdom's; use a plain store.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const ssml = `<speak xml:lang="en"><mark name="0"/>First sentence. <mark name="1"/>Second one.</speak>`;

describe('FlutterTTSClient', () => {
  let calls: { name: string; data?: unknown }[];

  beforeEach(() => {
    calls = [];
    win.flutter_inappwebview = {
      callHandler: vi.fn(async (name: string, data?: unknown) => {
        calls.push({ name, data });
        if (name === 'ttsInit') return { success: true };
        if (name === 'ttsVoices') {
          return {
            voices: [
              { id: 'en-us-x-1', name: 'English 1', lang: 'en-US' },
              { id: 'hi-in-x-1', name: 'Hindi 1', lang: 'hi-IN' },
            ],
          };
        }
        if (name === 'ttsSpeak') {
          const { utteranceId } = data as { utteranceId: string };
          // Flutter reports progress, then the end, after the call returns.
          setTimeout(() => {
            win.__flutterTTSEvent?.({ type: 'start', utteranceId });
            win.__flutterTTSEvent?.({ type: 'boundary', utteranceId, charIndex: 6 });
            win.__flutterTTSEvent?.({ type: 'end', utteranceId });
          }, 0);
          return { success: true };
        }
        return { success: true };
      }),
    };
  });

  afterEach(() => {
    delete win.flutter_inappwebview;
    delete win.__flutterTTSEvent;
  });

  test('maps Flutter events onto controller codes', () => {
    expect(toTTSMessage({ type: 'end', utteranceId: 'a' })).toEqual({ code: 'end' });
    expect(toTTSMessage({ type: 'error', utteranceId: 'a', message: 'x' })).toEqual({
      code: 'error',
      message: 'x',
    });
    expect(toTTSMessage({ type: 'boundary', utteranceId: 'a', charIndex: 3 })).toEqual({
      code: 'boundary',
      message: '3',
    });
    expect(toTTSMessage({ type: 'start', utteranceId: 'a' })).toBeNull();
  });

  test('speaks one sentence mark at a time and highlights each', async () => {
    const dispatchSpeakMark = vi.fn();
    const client = new FlutterTTSClient({ dispatchSpeakMark } as never);
    expect(await client.init()).toBe(true);
    client.setPrimaryLang('en');
    await client.setRate(1.5);

    const events: TTSMessageEvent[] = [];
    for await (const e of client.speak(ssml, new AbortController().signal)) events.push(e);

    const spoken = calls.filter((c) => c.name === 'ttsSpeak').map((c) => c.data);
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toMatchObject({ text: 'First sentence. ', lang: 'en', rate: 1.5 });
    expect(spoken[1]).toMatchObject({ text: 'Second one.' });
    expect(dispatchSpeakMark).toHaveBeenCalledTimes(2);
    expect(events.map((e) => [e.code, e.mark])).toEqual([
      ['boundary', '0'],
      ['end', '0'],
      ['boundary', '1'],
      ['end', '1'],
    ]);
  });

  test('a refused speak (daily limit) ends the run with an error', async () => {
    win.flutter_inappwebview!.callHandler = vi.fn(async (name: string) =>
      name === 'ttsSpeak' ? { success: false, limited: true } : { success: true },
    );
    const client = new FlutterTTSClient({ dispatchSpeakMark: vi.fn() } as never);
    await client.init();
    const events: TTSMessageEvent[] = [];
    for await (const e of client.speak(ssml, new AbortController().signal)) events.push(e);
    expect(events).toEqual([{ code: 'error', message: 'limit', mark: '0' }]);
  });

  test('abort stops waiting and tells Flutter to stop', async () => {
    win.flutter_inappwebview!.callHandler = vi.fn(async (name: string, data?: unknown) => {
      calls.push({ name, data });
      return { success: true }; // never sends 'end'
    });
    const client = new FlutterTTSClient({ dispatchSpeakMark: vi.fn() } as never);
    await client.init();
    const ac = new AbortController();
    const run = (async () => {
      const out: TTSMessageEvent[] = [];
      for await (const e of client.speak(ssml, ac.signal)) out.push(e);
      return out;
    })();
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await client.stop();
    await run;
    expect(calls.some((c) => c.name === 'ttsStop')).toBe(true);
  });

  test('pause (stop before the abort) does not speak the next sentence', async () => {
    win.flutter_inappwebview!.callHandler = vi.fn(async (name: string, data?: unknown) => {
      calls.push({ name, data });
      return { success: true }; // the first sentence never ends on its own
    });
    const client = new FlutterTTSClient({ dispatchSpeakMark: vi.fn() } as never);
    await client.init();
    const ac = new AbortController();
    const run = (async () => {
      for await (const _ of client.speak(ssml, ac.signal)) void _;
    })();
    await new Promise((r) => setTimeout(r, 10));
    // The controller's pause(): the client stops first, the abort comes later.
    await client.pause();
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await run;
    expect(calls.filter((c) => c.name === 'ttsSpeak')).toHaveLength(1);
  });

  test('lists phone voices for the language and picks the saved one', async () => {
    const client = new FlutterTTSClient();
    await client.init();
    const groups = await client.getVoices('hi');
    expect(groups[0]!.voices.map((v) => v.id)).toEqual(['hi-in-x-1']);
    expect(client.getCapabilities().mediaClock).toBe(false);
    expect(await client.getVoiceIdFromLang('hi')).toBe('');
    store.set('ttsPreferredVoices', JSON.stringify({ 'flutter-tts-hi': 'hi-in-x-1' }));
    expect(await client.getVoiceIdFromLang('hi')).toBe('hi-in-x-1');
    store.clear();
  });

  test('init fails outside the Flutter app', async () => {
    delete win.flutter_inappwebview;
    expect(await new FlutterTTSClient().init()).toBe(false);
  });
});
