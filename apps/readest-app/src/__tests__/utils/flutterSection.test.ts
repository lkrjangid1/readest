import { describe, test, expect } from 'vitest';
import {
  createSectionTracker,
  paragraphsOf,
  pickQuote,
  splitSentences,
  type SectionPosition,
} from '@/utils/flutterSection';

const at = (
  href: string,
  index: number,
  fraction: number | null,
  extra: Partial<SectionPosition> = {},
): SectionPosition => ({
  href,
  label: href.toUpperCase(),
  index,
  fraction,
  lastPage: false,
  pages: 10,
  ...extra,
});

describe('createSectionTracker', () => {
  test('first position starts tracking without a change', () => {
    const t = createSectionTracker();
    expect(t.update(at('a', 0, 0.1))).toBeNull();
    expect(t.update(at('a', 0, 0.5))).toBeNull();
  });

  test('moving to the next section after its last page is a finished chapter', () => {
    const t = createSectionTracker();
    t.update(at('a', 2, 0.2));
    t.update(at('a', 2, 1, { lastPage: true }));
    const c = t.update(at('b', 3, 0.1));
    expect(c).toEqual({
      from: { label: 'A', href: 'a', index: 2 },
      to: { label: 'B', href: 'b', index: 3 },
      finished: true,
      pages: 10,
    });
  });

  test('progress of 90% or more counts as finished', () => {
    const t = createSectionTracker();
    t.update(at('a', 0, 0.92));
    expect(t.update(at('b', 1, 0.05))?.finished).toBe(true);
  });

  test('leaving a chapter half read is not finished', () => {
    const t = createSectionTracker();
    t.update(at('a', 0, 0.4));
    const c = t.update(at('b', 1, 0.05));
    expect(c?.finished).toBe(false);
  });

  test('jumps and going back are never finished', () => {
    const t = createSectionTracker();
    t.update(at('a', 0, 1, { lastPage: true }));
    expect(t.update(at('d', 5, 0))?.finished).toBe(false);
    t.update(at('d', 5, 1, { lastPage: true }));
    expect(t.update(at('c', 4, 0.9))?.finished).toBe(false);
  });

  test('a chapter split over several files sums its pages', () => {
    const t = createSectionTracker();
    t.update(at('a', 0, 0.5, { pages: 4 }));
    t.update(at('a', 1, 0.2, { pages: 6 }));
    t.update(at('a', 1, 1, { pages: 6, lastPage: true }));
    const c = t.update(at('b', 2, 0, { pages: 8 }));
    expect(c?.finished).toBe(true);
    expect(c?.pages).toBe(10);
  });

  test('the next chapter inside the same file counts only after a small step', () => {
    const t = createSectionTracker();
    t.update(at('a', 0, 0.3));
    t.update(at('a', 0, 0.38));
    expect(t.update(at('b', 0, 0.42))?.finished).toBe(true);
    // A jump through the contents within the same file.
    expect(t.update(at('c', 0, 0.9))?.finished).toBe(false);
  });
});

describe('pickQuote', () => {
  test('splits sentences keeping their punctuation', () => {
    expect(splitSentences('One. Two! “Three?” Four')).toEqual(['One.', 'Two!', '“Three?”', 'Four']);
  });

  test('titles like Mrs. do not end a sentence', () => {
    expect(splitSentences('Their visits to Mrs. Philips were long. Then J. Austen wrote.')).toEqual(
      ['Their visits to Mrs. Philips were long.', 'Then J. Austen wrote.'],
    );
  });

  test('picks 1-3 sentences between 60 and 260 characters', () => {
    const paragraphs = [
      'Chapter 3',
      'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
      '“Do you not want to know who has taken it?” cried his wife impatiently.',
      'Short. Lines.',
    ];
    const q = pickQuote(paragraphs);
    expect(q).toBe(
      'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
    );
    expect(q!.length).toBeGreaterThanOrEqual(60);
    expect(q!.length).toBeLessThanOrEqual(260);
  });

  test('joins short sentences to reach the minimum length', () => {
    const q = pickQuote(['She smiled. The rain had stopped at last. The street was quiet again.']);
    expect(q).toBe('She smiled. The rain had stopped at last. The street was quiet again.');
  });

  test('returns null when nothing fits', () => {
    expect(pickQuote(['Too short.', 'x'.repeat(400)])).toBeNull();
    expect(pickQuote([])).toBeNull();
  });
});

describe('paragraphsOf', () => {
  const doc = new DOMParser().parseFromString(
    '<html><body><p>Preface text.</p><h2 id="ch1">One</h2><p>First a.</p><p>First b.</p>' +
      '<h2 id="ch2">Two</h2><p>Second.</p></body></html>',
    'text/html',
  );

  test('whole document without anchors', () => {
    expect(paragraphsOf(doc)).toEqual(['Preface text.', 'First a.', 'First b.', 'Second.']);
  });

  test('only the chapter between two anchors', () => {
    expect(paragraphsOf(doc, 'ch1', 'ch2')).toEqual(['First a.', 'First b.']);
    expect(paragraphsOf(doc, 'ch2')).toEqual(['Second.']);
    expect(paragraphsOf(doc, 'missing', 'ch1')).toEqual(['Preface text.']);
  });
});
