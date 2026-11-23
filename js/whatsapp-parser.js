/**
 * Pure parser for WhatsApp "Export Chat (Without Media)" .txt files.
 * Extracts Facebook and Instagram Reel links plus accompanying message text.
 */

const META_URL_RE =
  /https?:\/\/(?:(?:www|m|l)\.)?(?:instagram\.com\/(?:reel|reels|p|tv)\/[^\s<>()]+|facebook\.com\/(?:reel|share\/r|share\/v|watch|[^/\s]+\/videos)\/[^\s<>()]+|fb\.watch\/[^\s<>()]+)/gi;

const WHATSAPP_LINE_PREFIX_RE =
  /^(?:\[\d{1,2}[./-]\d{1,2}[./-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APMapm]{2})?\]|\d{1,2}[./-]\d{1,2}[./-]\d{2,4},?\s+\d{1,2}:\d{2}(?:\s?[APMapm]{2})?\s*-\s*)([^:]+:\s*)?/;

/**
 * Clean trailing punctuation and tracking query params for consistent deduplication.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeReelUrl(rawUrl) {
  if (!rawUrl) return '';
  const trimmed = String(rawUrl).replace(/[),.;!?'"\]]+$/g, '').trim();
  try {
    const parsed = new URL(trimmed);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('m.')) host = 'www.' + host.slice(2);
    if (!host.startsWith('www.') && (host === 'instagram.com' || host === 'facebook.com')) {
      host = 'www.' + host;
    }
    parsed.hostname = host;

    // For Instagram and Facebook reels, query params are tracking or session tokens
    // (igsh, igshid, stkn, mibextid, fbclid, utm_*, ref, s, etc.)
    if (
      host.includes('instagram.com') ||
      host.includes('facebook.com') ||
      host.includes('fb.watch')
    ) {
      parsed.search = '';
      parsed.hash = '';
    } else {
      const paramsToDrop = ['igsh', 'igshid', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'mibextid', 'stkn'];
      for (const key of paramsToDrop) {
        parsed.searchParams.delete(key);
      }
    }

    // Ensure consistent trailing slash on path
    let pathname = parsed.pathname;
    if (!pathname.endsWith('/')) {
      pathname += '/';
    }
    parsed.pathname = pathname;

    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Parse a WhatsApp exported .txt chat log into deduplicated Reel extraction items.
 *
 * @param {string} rawText
 * @param {Set<string>} [existingUrls]
 * @returns {{ items: Array<{ url: string, context: string }>, duplicateCount: number, alreadySavedCount: number }}
 */
export function parseWhatsAppExport(rawText, existingUrls = new Set()) {
  const normalizedExisting = new Set(
    Array.from(existingUrls, (url) => normalizeReelUrl(String(url)))
  );
  const seenInFile = new Set();
  const items = [];
  let duplicateCount = 0;
  let alreadySavedCount = 0;

  const lines = String(rawText ?? '').split(/\r?\n/);

  for (const line of lines) {
    const matches = line.match(META_URL_RE);
    if (!matches || matches.length === 0) continue;

    const cleanContext = line
      .replace(WHATSAPP_LINE_PREFIX_RE, '')
      .replace(META_URL_RE, '')
      .replace(/\s+/g, ' ')
      .trim();

    for (const rawMatch of matches) {
      const normalized = normalizeReelUrl(rawMatch);
      if (normalizedExisting.has(normalized)) {
        alreadySavedCount += 1;
        continue;
      }
      if (seenInFile.has(normalized)) {
        duplicateCount += 1;
        continue;
      }
      seenInFile.add(normalized);
      items.push({ url: normalized, context: cleanContext });
    }
  }

  return { items, duplicateCount, alreadySavedCount };
}

/**
 * Build a batch queue from pasted URLs and/or a WhatsApp Export Chat .txt string.
 * Tags items that already exist in the user's recipe library so the batch runner
 * skips them, prevents overwriting, and logs the existing recipe name.
 */
export function buildBatchQueue({
  urlsText = '',
  whatsappText = '',
  existingRecipes = [],
  includeAlreadySaved = true,
}) {
  const existingMap = new Map();
  for (const r of existingRecipes) {
    if (r.sourceUrl) {
      existingMap.set(normalizeReelUrl(r.sourceUrl), r);
    }
  }

  const items = [];
  const seen = new Set();
  let duplicateCount = 0;
  let alreadySavedCount = 0;

  if (whatsappText.trim()) {
    const preFilter = includeAlreadySaved ? new Set() : new Set(existingMap.keys());
    const parsed = parseWhatsAppExport(whatsappText, preFilter);
    duplicateCount += parsed.duplicateCount;

    for (const item of parsed.items) {
      const norm = normalizeReelUrl(item.url);
      if (!seen.has(norm)) {
        seen.add(norm);
        const existing = existingMap.get(norm);
        if (existing) {
          alreadySavedCount += 1;
          if (includeAlreadySaved) {
            items.push({ ...item, url: norm, existingRecipe: existing });
          }
        } else {
          items.push({ ...item, url: norm, existingRecipe: null });
        }
      }
    }
  }

  for (const rawLine of urlsText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const norm = normalizeReelUrl(trimmed);
    if (seen.has(norm)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(norm);

    const existing = existingMap.get(norm);
    if (existing) {
      alreadySavedCount += 1;
      if (includeAlreadySaved) {
        items.push({ url: norm, context: '', existingRecipe: existing });
      }
    } else {
      items.push({ url: norm, context: '', existingRecipe: null });
    }
  }

  return { items, duplicateCount, alreadySavedCount, totalFound: items.length };
}
