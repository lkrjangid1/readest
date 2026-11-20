import type { FoliateView } from '@/types/view';
import type { BookData } from '@/store/bookDataStore';
import type { TOCItem } from '@/libs/document';
import type { PageInfo } from '@/types/book';
import {
  createSectionTracker,
  paragraphsOf,
  pickQuote,
  type SectionChange,
  type SectionPosition,
} from './flutterSection';

type FlutterHost = { callHandler: (name: string, data?: unknown) => Promise<unknown> };
const flutterHost = (): FlutterHost | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { flutter_inappwebview?: FlutterHost }).flutter_inappwebview;

const trackers = new Map<string, ReturnType<typeof createSectionTracker>>();
/** Spine index of the chapter each book just finished. */
const lastFinished = new Map<string, { sec: FinishedSection; quote?: Promise<string | null> }>();

const SAMPLE_TIMEOUT_MS = 1500;

type Renderer = {
  scrolled?: boolean;
  page?: number;
  pages?: number;
  size?: number;
  end?: number;
  viewSize?: number;
};

/** Where the reader is inside the rendered spine section. */
const positionIn = (
  view: FoliateView | null,
  tocItem: TOCItem | undefined,
  section: PageInfo,
  bookFraction: number,
): SectionPosition => {
  let fraction: number | null = null;
  let lastPage = false;
  let pages: number | null = null;
  try {
    const r = view?.renderer as unknown as Renderer | undefined;
    if (r?.scrolled) {
      const vs = r.viewSize ?? 0;
      const end = r.end ?? 0;
      if (vs > 0) {
        fraction = Math.min(1, Math.max(0, end / vs));
        lastPage = vs - end <= 2;
        if (r.size) pages = Math.max(1, Math.round(vs / r.size));
      }
    } else if (r && typeof r.page === 'number' && typeof r.pages === 'number' && r.pages > 0) {
      fraction = Math.min(1, (r.page + 1) / r.pages);
      lastPage = r.page >= r.pages - 1;
      pages = r.pages;
    }
    if (fraction == null && view) {
      const sf = view.getSectionFractions();
      const a = sf[section.current];
      const b = sf[section.current + 1];
      if (a != null && b != null && b > a) {
        fraction = Math.min(1, Math.max(0, (bookFraction - a) / (b - a)));
      }
    }
  } catch {
    // Fail soft: no position, no card.
  }
  return {
    href: tocItem?.href || `#${section.current}`,
    label: (tocItem?.label ?? '').trim(),
    index: section.current,
    fraction,
    lastPage,
    pages,
  };
};

interface FinishedSection {
  index: number;
  href: string;
  /** Href of the next chapter when it starts in the same file. */
  nextHref?: string;
}

const fragment = (href: string | undefined) => {
  const i = href ? href.indexOf('#') : -1;
  return i >= 0 ? href!.slice(i + 1) : undefined;
};

const sampleOf = async (bookData: BookData, sec: FinishedSection): Promise<string | null> => {
  try {
    const section = bookData.bookDoc?.sections?.[sec.index];
    if (!section?.createDocument) return null;
    const doc = await section.createDocument();
    return pickQuote(paragraphsOf(doc, fragment(sec.href), fragment(sec.nextHref)));
  } catch {
    return null;
  }
};

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);

/**
 * Called on every relocate of the primary view: when the reader moves on
 * from a chapter it tells Flutter (`onSectionChange`), with a quote picked
 * from the chapter just finished.
 */
export const trackFlutterSection = (
  bookKey: string,
  bookData: BookData,
  view: FoliateView | null,
  tocItem: TOCItem | undefined,
  section: PageInfo,
  fraction: number,
) => {
  const host = flutterHost();
  if (!host || bookData.isFixedLayout) return;
  let tracker = trackers.get(bookKey);
  if (!tracker) {
    tracker = createSectionTracker();
    trackers.set(bookKey, tracker);
  }
  const change = tracker.update(positionIn(view, tocItem, section, fraction));
  if (change) void notify(host, bookKey, bookData, change, fraction);
};

const notify = async (
  host: FlutterHost,
  bookKey: string,
  bookData: BookData,
  change: SectionChange,
  fraction: number,
) => {
  let quote: string | null = null;
  if (change.finished) {
    const sec: FinishedSection = {
      index: change.from.index,
      href: change.from.href,
      nextHref: change.to.index === change.from.index ? change.to.href : undefined,
    };
    const sample = sampleOf(bookData, sec);
    lastFinished.set(bookKey, { sec, quote: sample });
    quote = await withTimeout(sample, SAMPLE_TIMEOUT_MS, null);
  }
  const book = bookData.book;
  host
    .callHandler('onSectionChange', {
      from: { label: change.from.label, href: change.from.href },
      to: { label: change.to.label, href: change.to.href },
      finished: change.finished,
      fraction,
      sectionPages: change.pages,
      quote,
      bookTitle: book?.title ?? '',
      author: book?.author ?? '',
    })
    .catch(() => {});
};

/** A quote from the chapter the reader just finished, or null. */
export const getSectionSample = async (
  bookKey: string,
  bookData: BookData | null | undefined,
): Promise<string | null> => {
  const last = lastFinished.get(bookKey);
  if (!last || !bookData) return null;
  last.quote ??= sampleOf(bookData, last.sec);
  return last.quote;
};

export const forgetFlutterSection = (bookKey: string) => {
  trackers.delete(bookKey);
  lastFinished.delete(bookKey);
};
