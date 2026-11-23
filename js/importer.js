/**
 * Import workflows: single Reel URL, Batch/WhatsApp .txt queue, and OneNote bulk files.
 */

import { extractReel, parseOneNoteFile, parseRecipeText, wakeBackend } from './api.js?v=4';
import { saveRecipe } from './recipes.js?v=4';
import { buildBatchQueue, normalizeReelUrl, parseWhatsAppExport } from './whatsapp-parser.js?v=4';

export { buildBatchQueue, normalizeReelUrl, parseWhatsAppExport };

/**
 * Extract a single Reel URL. Returns { status: 'ok', recipe } or { status: 'blocked', message, rawCaption }.
 */
export async function runSingleReelExtraction(url, extraContext = '', onStatus = null) {
  await wakeBackend(onStatus);
  if (onStatus) onStatus('Downloading Reel via yt-dlp & extracting with Gemini (takes 15-40s)...');
  const result = await extractReel(url, extraContext, onStatus);
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
 * Process a batch queue sequentially:
 * - If a recipe already exists in the library, it is skipped and logged to prevent overwrite.
 * - If a recipe was previously deleted by the user, it is no longer in existingRecipes, so it will be re-imported.
 * - Newly extracted recipes are saved immediately to Firestore.
 */
export async function processBatchQueue(ownerUid, queueItems, onProgress, existingRecipes = []) {
  const existingMap = new Map();
  for (const r of existingRecipes) {
    if (r.sourceUrl) {
      existingMap.set(normalizeReelUrl(r.sourceUrl), r);
    }
  }

  await wakeBackend((msg) => onProgress?.({ type: 'wake', message: msg }));
  const summary = { saved: 0, skipped: 0, blocked: [], failed: [] };

  for (let i = 0; i < queueItems.length; i += 1) {
    const item = queueItems[i];
    const normUrl = normalizeReelUrl(item.url);

    // 1. Check if recipe ALREADY EXISTS in the user's active library
    const existing = item.existingRecipe || existingMap.get(normUrl);
    if (existing) {
      summary.skipped += 1;
      onProgress?.({
        type: 'item_done',
        index: i,
        total: queueItems.length,
        status: 'skipped',
        url: item.url,
        title: existing.title || 'Untitled',
        message: `Recipe already exists ("${existing.title}")`,
      });
      continue;
    }

    // 2. Not in library: extract & save
    onProgress?.({ type: 'item_start', index: i, total: queueItems.length, url: item.url });

    try {
      const outcome = await extractReel(item.url, item.context || '');
      if (outcome.status === 'blocked_fallback_required') {
        summary.blocked.push({ ...item, message: outcome.message });
        onProgress?.({
          type: 'item_done',
          index: i,
          total: queueItems.length,
          status: 'blocked',
          url: item.url,
          message: outcome.message,
        });
      } else if (outcome.recipe) {
        await saveRecipe(ownerUid, outcome.recipe);
        summary.saved += 1;
        // Register in existingMap so any duplicate later in this run is also skipped
        existingMap.set(normUrl, outcome.recipe);
        onProgress?.({
          type: 'item_done',
          index: i,
          total: queueItems.length,
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
        total: queueItems.length,
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
