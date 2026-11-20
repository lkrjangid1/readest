import { getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { parseSSMLMarks } from '@/utils/ssml';
import { flutterHost } from '@/utils/flutterHost';
import { TTSCapabilities, TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { TTSUtils } from './TTSUtils';
import type { TTSController } from './TTSController';

/**
 * Read aloud through the phone's text-to-speech in the Flutter app
 * (`flutter_tts`). Speaks one sentence mark at a time, like the Tauri native
 * client, so the controller keeps highlighting the spoken sentence.
 *
 * JS → Flutter: callHandler `ttsInit`, `ttsSpeak` {utteranceId, text, lang,
 * voice, rate, pitch}, `ttsStop`, `ttsVoices`.
 * Flutter → JS: `window.__flutterTTSEvent({type, utteranceId, charIndex?,
 * message?})` with type `start` | `boundary` | `end` | `error`.
 */

export type FlutterTTSEvent = {
  type: 'start' | 'boundary' | 'end' | 'error';
  utteranceId: string;
  charIndex?: number;
  message?: string;
};

type Utterance = {
  queue: TTSMessageEvent[];
  wake: (() => void) | null;
  done: boolean;
};

type SpeakResult = { success?: boolean; error?: string; limited?: boolean } | null | undefined;

/** Maps a Flutter event onto the controller's message codes (null = ignore). */
export const toTTSMessage = (event: FlutterTTSEvent): TTSMessageEvent | null => {
  switch (event.type) {
    case 'end':
      return { code: 'end' };
    case 'error':
      return { code: 'error', message: event.message || 'TTS error' };
    case 'boundary':
      return { code: 'boundary', message: String(event.charIndex ?? 0) };
    default:
      return null;
  }
};

// One TTSController (and client) per read-aloud session, but a single global
// entry point for Flutter: route each event to the client that owns it.
const liveClients = new Set<FlutterTTSClient>();
const installEventSink = () => {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __flutterTTSEvent?: (e: FlutterTTSEvent) => void };
  w.__flutterTTSEvent = (event: FlutterTTSEvent) => {
    if (!event || typeof event.utteranceId !== 'string') return;
    liveClients.forEach((client) => client.handleEvent(event));
  };
};

let utteranceSeq = 0;

export class FlutterTTSClient implements TTSClient {
  name = 'flutter-tts';
  initialized = false;
  controller?: TTSController;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = '';
  #rate = 1.0;
  #pitch = 1.0;
  #utterances = new Map<string, Utterance>();

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  async #call<T>(name: string, data?: unknown): Promise<T | undefined> {
    const host = flutterHost();
    if (!host) return undefined;
    return (await host.callHandler(name, data)) as T;
  }

  async init(): Promise<boolean> {
    if (!flutterHost()) return false;
    try {
      const result = await this.#call<{ success?: boolean }>('ttsInit');
      this.initialized = !!result?.success;
    } catch (error) {
      console.warn('Flutter TTS init failed:', error);
      this.initialized = false;
    }
    if (this.initialized) {
      installEventSink();
      liveClients.add(this);
    }
    return this.initialized;
  }

  /** An event from Flutter: queue it for the utterance it belongs to. */
  handleEvent(event: FlutterTTSEvent) {
    const utterance = this.#utterances.get(event.utteranceId);
    if (!utterance) return;
    const message = toTTSMessage(event);
    if (!message) return;
    utterance.queue.push(message);
    if (message.code === 'end' || message.code === 'error') utterance.done = true;
    utterance.wake?.();
  }

  async *speakMark(mark: TTSMark, preload: boolean, signal: AbortSignal) {
    if (preload) {
      yield { code: 'end', message: 'Dummy preload finished' } as TTSMessageEvent;
      return;
    }
    const lang = mark.language || this.#primaryLang;
    const voiceId = await this.getVoiceIdFromLang(lang);
    this.#currentVoiceId = voiceId;
    this.#speakingLang = lang;

    const utteranceId = `ftts-${Date.now()}-${++utteranceSeq}`;
    const utterance: Utterance = { queue: [], wake: null, done: false };
    // Registered before the call: a short sentence can end before it returns.
    this.#utterances.set(utteranceId, utterance);
    const onAbort = () => {
      utterance.done = true;
      utterance.wake?.();
    };
    signal.addEventListener('abort', onAbort);
    try {
      const result = await this.#call<SpeakResult>('ttsSpeak', {
        utteranceId,
        text: mark.text,
        lang,
        voice: voiceId,
        rate: this.#rate,
        pitch: this.#pitch,
      });
      if (!result?.success) {
        yield {
          code: 'error',
          message: result?.limited ? 'limit' : result?.error || 'TTS unavailable',
          mark: mark.name,
        } as TTSMessageEvent;
        return;
      }
      while (!signal.aborted) {
        const event = utterance.queue.shift();
        if (event) {
          event.mark = mark.name;
          yield event;
          if (event.code === 'end' || event.code === 'error') return;
          continue;
        }
        if (utterance.done) return;
        // Woken by an event or the abort; the timeout guards a lost event.
        await new Promise<void>((resolve) => {
          utterance.wake = resolve;
          setTimeout(resolve, 500);
        });
        utterance.wake = null;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.#utterances.delete(utteranceId);
    }
  }

  async *speak(ssml: string, signal: AbortSignal, preload = false) {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    for (const mark of marks) {
      if (!preload) this.controller?.dispatchSpeakMark(mark);
      for await (const event of this.speakMark(mark, preload, signal)) {
        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          return;
        }
        yield event;
        if (event.code === 'error') return;
      }
    }
  }

  async getVoiceIdFromLang(lang: string) {
    const preferredVoiceId = TTSUtils.getPreferredVoice(this.name, lang);
    const preferred = this.#voices.find((v) => v.id === preferredVoiceId);
    // Empty = the engine's default voice for the language.
    return preferred && isSameLang(preferred.lang, lang) ? preferred.id : '';
  }

  // The phone engines have no reliable pause: stop, and the controller
  // re-speaks the sentence on resume ('stop-paused').
  async pause() {
    await this.stop();
    return false;
  }

  async resume() {
    return false;
  }

  async stop() {
    try {
      await Promise.race([
        this.#call('ttsStop'),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch (error) {
      console.warn('Flutter TTS stop failed:', error);
    }
    this.#utterances.forEach((u) => {
      u.done = true;
      u.wake?.();
    });
  }

  async setRate(rate: number) {
    // 1.0 = normal; Flutter maps it onto the engine's scale.
    this.#rate = rate;
  }

  async setPitch(pitch: number) {
    this.#pitch = pitch;
  }

  async setVoice(voice: string) {
    this.#currentVoiceId = voice;
  }

  async getAllVoices() {
    if (this.#voices.length > 0 || !this.initialized) return this.#voices;
    try {
      const result = await this.#call<{ voices?: TTSVoice[] }>('ttsVoices');
      this.#voices = (result?.voices ?? []).filter((v) => v && v.id && v.lang);
    } catch (error) {
      console.warn('Flutter TTS voices failed:', error);
    }
    return this.#voices;
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
    const voices = (await this.getAllVoices()).filter((v) => isSameLang(v.lang, lang));
    return [
      {
        id: 'flutter',
        name: 'System TTS',
        voices: voices.sort(TTSUtils.sortVoicesPreferLocaleFunc(locale)),
        disabled: !this.initialized || voices.length === 0,
      },
    ];
  }

  setPrimaryLang(lang: string) {
    this.#primaryLang = lang;
  }

  getCapabilities(): TTSCapabilities {
    // The OS renders the audio: no media clock, word timings or gap control.
    return { wordBoundaries: false, mediaClock: false, gapControl: false, liveRateChange: false };
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId() {
    return this.#currentVoiceId;
  }

  getSpeakingLang() {
    return this.#speakingLang;
  }

  async shutdown() {
    liveClients.delete(this);
    await this.stop();
    this.initialized = false;
  }
}
