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
  const trimmed = rawUrl.replace(/[),.;!?'"\]]+$/g, '').trim();
  try {
    const parsed = new URL(trimmed);
    const paramsToDrop = ['igsh', 'igshid', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign'];
    for (const key of paramsToDrop) {
      parsed.searchParams.delete(key);
    }
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
