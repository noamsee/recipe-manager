/**
 * Bilingual RTL/LTR direction helpers for Hebrew and English recipe text.
 */

const HEBREW_CHAR_RE = /[\u0590-\u05FF]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;

/**
 * Determine whether text should render RTL ('rtl') or LTR ('ltr').
 * Uses character counts so mixed Hebrew + English lines pick the dominant script.
 *
 * @param {string | null | undefined} text
 * @param {'he' | 'en' | null} [explicitLang]
 * @returns {'rtl' | 'ltr'}
 */
export function detectTextDirection(text, explicitLang = null) {
  if (explicitLang === 'he') return 'rtl';
  if (explicitLang === 'en' && !text) return 'ltr';
  const input = String(text ?? '');
  const hebrewMatches = input.match(HEBREW_CHAR_RE);
  const hebrewCount = hebrewMatches ? hebrewMatches.length : 0;
  if (hebrewCount === 0) return 'ltr';

  const latinMatches = input.match(LATIN_CHAR_RE);
  const latinCount = latinMatches ? latinMatches.length : 0;
  if (hebrewCount >= latinCount || hebrewCount >= 3) {
    return 'rtl';
  }
  return 'ltr';
}

/**
 * Apply dir and lang attributes cleanly to a DOM element.
 *
 * @param {HTMLElement | null} element
 * @param {string} text
 * @param {'he' | 'en' | null} [explicitLang]
 */
export function applyDirection(element, text, explicitLang = null) {
  if (!element) return;
  const dir = detectTextDirection(text, explicitLang);
  element.setAttribute('dir', dir);
}
