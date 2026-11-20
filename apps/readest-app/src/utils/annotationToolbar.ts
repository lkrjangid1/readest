import type { AnnotationToolType } from '@/types/annotator';

// Canonical order of every annotation tool. Kept in sync with
// `annotationToolButtons` in AnnotationTools.tsx (asserted by a unit test).
export const ALL_ANNOTATION_TOOL_TYPES: AnnotationToolType[] = [
  'copy',
  'highlight',
  'annotate',
  'search',
  'dictionary',
  'translate',
  'tts',
  'proofread',
  'share',
  'quote',
];

// The default toolbar before 'quote' existed: a saved list equal to it was
// never customised, so it follows the current default.
const LEGACY_DEFAULT_TOOLBAR_ITEMS: AnnotationToolType[] = [
  'copy',
  'highlight',
  'annotate',
  'search',
  'dictionary',
  'translate',
  'tts',
  'proofread',
];

// Default toolbar: the pre-existing tools in their original order, with
// 'quote' (Flutter only) next to highlight. 'share' starts hidden in the
// Available tray per the #4014 design.
export const DEFAULT_ANNOTATION_TOOLBAR_ITEMS: AnnotationToolType[] = [
  'copy',
  'highlight',
  'quote',
  'annotate',
  'search',
  'dictionary',
  'translate',
  'tts',
  'proofread',
];

// Drop unknown/duplicate entries; fall back to the default when unset (a
// pre-existing per-book config may not carry the field yet).
const isLegacyDefault = (items: AnnotationToolType[]) =>
  items.length === LEGACY_DEFAULT_TOOLBAR_ITEMS.length &&
  items.every((type, i) => type === LEGACY_DEFAULT_TOOLBAR_ITEMS[i]);

const sanitize = (items: AnnotationToolType[] | undefined): AnnotationToolType[] => {
  const source = !items || isLegacyDefault(items) ? DEFAULT_ANNOTATION_TOOLBAR_ITEMS : items;
  const seen = new Set<AnnotationToolType>();
  const out: AnnotationToolType[] = [];
  for (const type of source) {
    if (ALL_ANNOTATION_TOOL_TYPES.includes(type) && !seen.has(type)) {
      seen.add(type);
      out.push(type);
    }
  }
  return out;
};

// Whether a tool can work here: 'share' needs a share sheet, 'quote' the
// Flutter app.
export const isToolSupported = (
  type: AnnotationToolType,
  canShare: boolean,
  canQuote = false,
): boolean => (type !== 'share' || canShare) && (type !== 'quote' || canQuote);

// Visible tools to render in the live selection toolbar, in order.
export const getToolbarToolTypes = (
  items: AnnotationToolType[] | undefined,
  canShare: boolean,
  canQuote = false,
): AnnotationToolType[] =>
  sanitize(items).filter((type) => isToolSupported(type, canShare, canQuote));

// Hidden tools (the "Available" tray), in canonical order.
export const getAvailableToolTypes = (
  items: AnnotationToolType[] | undefined,
  canShare: boolean,
  canQuote = false,
): AnnotationToolType[] => {
  const visible = new Set(sanitize(items));
  return ALL_ANNOTATION_TOOL_TYPES.filter(
    (type) => !visible.has(type) && isToolSupported(type, canShare, canQuote),
  );
};

// The saved list (sanitised) including tools this platform hides, so an
// edit here doesn't drop a tool another device shows.
export const getSavedToolTypes = (items: AnnotationToolType[] | undefined): AnnotationToolType[] =>
  sanitize(items);

// Add `type` to the visible list at `atIndex` (default: end). No-op if present.
export const addToolToToolbar = (
  visible: AnnotationToolType[],
  type: AnnotationToolType,
  atIndex?: number,
): AnnotationToolType[] => {
  if (visible.includes(type)) return visible;
  const next = [...visible];
  next.splice(atIndex ?? next.length, 0, type);
  return next;
};

// Remove `type` from the visible list. No-op if absent.
export const removeToolFromToolbar = (
  visible: AnnotationToolType[],
  type: AnnotationToolType,
): AnnotationToolType[] => visible.filter((type_) => type_ !== type);

// Move `fromType` to where `toType` currently sits within the visible list.
export const reorderToolbar = (
  visible: AnnotationToolType[],
  fromType: AnnotationToolType,
  toType: AnnotationToolType,
): AnnotationToolType[] => {
  const from = visible.indexOf(fromType);
  const to = visible.indexOf(toType);
  if (from < 0 || to < 0 || from === to) return visible;
  const next = [...visible];
  const spliced = next.splice(from, 1);
  next.splice(to, 0, spliced[0]!);
  return next;
};
