/**
 * Chapter-finished detection and quote picking for the Flutter host's
 * "Chapter done" card. Pure helpers, driven by readerStore.setProgress.
 */

export interface SectionPosition {
  /** TOC href of the current chapter (falls back to `#<spine index>`). */
  href: string;
  label: string;
  /** Spine index of the rendered section. */
  index: number;
  /** How far into the rendered spine section, 0..1 (null if unknown). */
  fraction: number | null;
  /** True when the last page of the rendered spine section is on screen. */
  lastPage: boolean;
  /** Pages of the rendered spine section (null if unknown). */
  pages: number | null;
}

export interface SectionChange {
  from: { label: string; href: string; index: number };
  to: { label: string; href: string; index: number };
  /** The reader had reached the end of `from` before moving on. */
  finished: boolean;
  /** Pages read in `from` (spine sections summed), null if unknown. */
  pages: number | null;
}

/** Progress in a chapter from which it counts as read. */
export const SECTION_FINISHED_AT = 0.9;

/** Largest move inside one file that still counts as turning the page. */
const MAX_IN_FILE_STEP = 0.12;

interface TrackedSection {
  href: string;
  label: string;
  index: number;
  maxFraction: number;
  /** Fraction at the latest position. */
  lastFraction: number | null;
  reachedEnd: boolean;
  /** Pages of the spine sections already left behind in this chapter. */
  pagesBefore: number;
  pages: number | null;
}

/**
 * Follows the reading position and reports when the chapter changes. A
 * change counts as `finished` only when it moves forward to the next
 * spine section (or a later chapter in the same one) after the end of the
 * previous chapter was on screen; jumps through the TOC and going back
 * never do.
 */
export const createSectionTracker = () => {
  let current: TrackedSection | null = null;

  const start = (p: SectionPosition): TrackedSection => ({
    href: p.href,
    label: p.label,
    index: p.index,
    maxFraction: p.fraction ?? 0,
    lastFraction: p.fraction,
    reachedEnd: p.lastPage,
    pagesBefore: 0,
    pages: p.pages,
  });

  return {
    update(p: SectionPosition): SectionChange | null {
      const prev = current;
      if (!prev) {
        current = start(p);
        return null;
      }
      if (p.href === prev.href) {
        if (p.index !== prev.index) {
          // Same chapter, next file of it: what counts is the new file.
          if (p.index > prev.index && prev.pages) prev.pagesBefore += prev.pages;
          prev.index = p.index;
          prev.maxFraction = p.fraction ?? 0;
          prev.reachedEnd = p.lastPage;
        } else {
          prev.maxFraction = Math.max(prev.maxFraction, p.fraction ?? 0);
          prev.reachedEnd = prev.reachedEnd || p.lastPage;
        }
        prev.lastFraction = p.fraction;
        prev.pages = p.pages ?? prev.pages;
        if (p.label) prev.label = p.label;
        return null;
      }
      const step = p.index - prev.index;
      let finished: boolean;
      if (step === 1) {
        // Next spine section: the previous chapter's end was on screen.
        finished = prev.reachedEnd || prev.maxFraction >= SECTION_FINISHED_AT;
      } else if (step === 0) {
        // Next chapter inside the same file: a page or two further on,
        // not a jump through the contents.
        const a = prev.lastFraction;
        const b = p.fraction;
        finished = a != null && b != null && b >= a && b - a <= MAX_IN_FILE_STEP;
      } else {
        finished = false;
      }
      const pages = prev.pages == null ? null : prev.pagesBefore + prev.pages;
      current = start(p);
      return {
        from: { label: prev.label, href: prev.href, index: prev.index },
        to: { label: p.label, href: p.href, index: p.index },
        finished,
        pages: step === 0 ? null : pages,
      };
    },
    reset() {
      current = null;
    },
  };
};

const MIN_QUOTE = 60;
const MAX_QUOTE = 260;

/** Words ending in a full stop that don't end a sentence ("Mrs. Bennet"). */
const ABBREVIATION =
  /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Mme|Mlle|Prof|Rev|Gen|Col|Capt|Lt|vs|etc|[A-Z])\.$/;

/** Splits a paragraph into sentences (no lookbehind: old WebViews). */
export const splitSentences = (text: string): string[] => {
  const out: string[] = [];
  let carry = '';
  const re = /[^.!?。！？]+(?:[.!?。！？]+["'”’»)\]]*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = (carry ? `${carry} ${m[0].trim()}` : m[0].trim()).trim();
    carry = '';
    if (ABBREVIATION.test(s)) carry = s;
    else if (s) out.push(s);
    if (m[0].length === 0) re.lastIndex++;
  }
  if (carry) out.push(carry);
  return out;
};

const scoreQuote = (q: string): number => {
  let score = 0;
  // Around 150 characters reads best on a card.
  score -= Math.abs(q.length - 150) / 30;
  if (/^[“"'‘«]/.test(q)) score -= 1.5; // dialogue
  if (/\d/.test(q)) score -= 1.5;
  if (/[[\]{}<>|_*#@\\/]/.test(q)) score -= 3;
  if (/^[A-ZÀ-ɏͰ-ϿЀ-ӿ]/.test(q)) score += 0.5;
  if (!/[.!?。！？]["'”’»)\]]*$/.test(q)) score -= 2;
  // Mostly letters, not a list or table.
  const letters = (q.match(/\p{L}/gu) || []).length;
  if (letters / q.length < 0.7) score -= 2;
  return score;
};

/**
 * Picks a quote of 1–3 sentences and 60–260 characters from a chapter's
 * paragraphs, or null when there is none.
 */
export const pickQuote = (paragraphs: string[]): string | null => {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const raw of paragraphs) {
    const para = raw.replace(/\s+/g, ' ').trim();
    if (para.length < MIN_QUOTE) continue;
    const sentences = splitSentences(para);
    for (let i = 0; i < sentences.length; i++) {
      let q = '';
      for (let n = 0; n < 3 && i + n < sentences.length; n++) {
        q = q ? `${q} ${sentences[i + n]}` : sentences[i + n]!;
        if (q.length > MAX_QUOTE) break;
        if (q.length < MIN_QUOTE) continue;
        const s = scoreQuote(q);
        if (s > bestScore) {
          bestScore = s;
          best = q;
        }
      }
    }
  }
  return best;
};

const byId = (doc: Document, id: string | undefined) => {
  if (!id) return null;
  try {
    return doc.getElementById(decodeURIComponent(id));
  } catch {
    return doc.getElementById(id);
  }
};

/**
 * Paragraph texts of a section document, in order. With [fromId] (and
 * [toId]) only those of the chapter between the two anchors: one file
 * often holds several chapters.
 */
export const paragraphsOf = (doc: Document, fromId?: string, toId?: string): string[] => {
  const start = byId(doc, fromId);
  const end = byId(doc, toId);
  let range: Range | null = null;
  if (start || end) {
    range = doc.createRange();
    if (start) range.setStartBefore(start);
    else if (doc.body) range.setStart(doc.body, 0);
    if (end) range.setEndBefore(end);
    else if (doc.body) range.setEnd(doc.body, doc.body.childNodes.length);
  }
  const nodes = doc.querySelectorAll('p, blockquote, li');
  const out: string[] = [];
  nodes.forEach((n) => {
    if (range && !range.intersectsNode(n)) return;
    const t = n.textContent ?? '';
    if (t.trim()) out.push(t);
  });
  if (out.length === 0 && doc.body?.textContent) {
    out.push(...doc.body.textContent.split(/\n\s*\n/));
  }
  return out;
};
