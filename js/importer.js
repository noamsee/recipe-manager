/**
 * Import workflows: single Reel URL, Batch/WhatsApp .txt queue, and OneNote bulk files.
 */

import { extractReel, parseOneNoteFile, parseRecipeText, wakeBackend } from './api.js';
import { saveRecipe } from './recipes.js';
import { normalizeReelUrl, parseWhatsAppExport } from './whatsapp-parser.js';

/**
 * Extract a single Reel URL. Returns { status: 'ok', recipe } or { status: 'blocked', message, rawCaption }.
 */
export async function runSingleReelExtraction(url, extraContext = '', onStatus = null) {
  await wakeBackend(onStatus);
  if (onStatus) onStatus('Downloading Reel and extracting recipe via Gemini...');
  const result = await extractReel(url, extraContext);
  if (result.status === 'blocked_fallback_required') {
    return {
      status: 'blocked',
      message: result.message || 'Reel blocked by platform. Paste the caption below.',
      rawCaption: result.rawCaption || '',
      url,
    };
  }
  return { status: 'ok', recipe: result.recipe, url };
}

/**
 * Parse a raw caption/text paste into a structured recipe.
 */
export async function runCaptionFallbackExtraction(text, sourceUrl = null, onStatus = null) {
  await wakeBackend(onStatus);
  if (onStatus) onStatus('Structuring pasted recipe text via Gemini...');
  return parseRecipeText(text, sourceUrl);
}

/**
 * Build a batch queue from pasted URLs and/or a WhatsApp Export Chat .txt string,
 * deduplicating against already saved recipe source URLs.
 */
export function buildBatchQueue({ urlsText = '', whatsappText = '', existingRecipes = [] }) {
  const existingUrls = new Set(
    existingRecipes.map((r) => r.sourceUrl).filter(Boolean).map((u) => normalizeReelUrl(u))
  );

  const items = [];
  const seen = new Set();
  let duplicateCount = 0;
  let alreadySavedCount = 0;

  if (whatsappText.trim()) {
    const parsed = parseWhatsAppExport(whatsappText, existingUrls);
    duplicateCount += parsed.duplicateCount;
    alreadySavedCount += parsed.alreadySavedCount;
    for (const item of parsed.items) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        items.push(item);
      }
    }
  }

  for (const rawLine of urlsText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const normalized = normalizeReelUrl(trimmed);
    if (existingUrls.has(normalized)) {
      alreadySavedCount += 1;
      continue;
    }
    if (seen.has(normalized)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(normalized);
    items.push({ url: normalized, context: '' });
  }

  return { items, duplicateCount, alreadySavedCount };
}

/**
 * Process a batch queue sequentially, saving successful recipes immediately to Firestore
 * and returning per-item statuses (including blocked items that need manual caption paste).
 */
export async function processBatchQueue(ownerUid, queueItems, onProgress) {
  await wakeBackend((msg) => onProgress?.({ type: 'wake', message: msg }));
  const summary = { saved: 0, blocked: [], failed: [] };

  for (let i = 0; i < queueItems.length; i += 1) {
    const item = queueItems[i];
    onProgress?.({ type: 'item_start', index: i, total: queueItems.length, url: item.url });

    try {
      const outcome = await extractReel(item.url, item.context || '');
      if (outcome.status === 'blocked_fallback_required') {
        summary.blocked.push({ ...item, message: outcome.message });
        onProgress?.({
          type: 'item_done',
          index: i,
          status: 'blocked',
          url: item.url,
          message: outcome.message,
        });
      } else if (outcome.recipe) {
        await saveRecipe(ownerUid, outcome.recipe);
        summary.saved += 1;
        onProgress?.({
          type: 'item_done',
          index: i,
          status: 'saved',
          url: item.url,
          title: outcome.recipe.title,
        });
      }
    } catch (err) {
      summary.failed.push({ ...item, message: err.message });
      onProgress?.({
        type: 'item_done',
        index: i,
        status: 'failed',
        url: item.url,
        message: err.message,
      });
    }
  }

  return summary;
}

/**
 * Upload an exported OneNote file (.html, .docx, .pdf, .txt) and return parsed candidate recipes.
 */
export async function extractRecipesFromOneNoteFile(file, onStatus = null) {
  await wakeBackend(onStatus);
  if (onStatus) onStatus(`Parsing "${file.name}" via Gemini...`);
  const payload = await parseOneNoteFile(file);
  return payload.recipes || [];
}
