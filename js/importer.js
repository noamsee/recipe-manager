/**
 * Import workflows: single Reel URL, Batch/WhatsApp .txt queue, and OneNote bulk files.
 * Integrates with persistent Firestore importQueue & importLogs.
 */

import { extractReel, parseOneNoteFile, parseRecipeText, wakeBackend } from './api.js?v=5';
import {
  clearAllUnparsableItems,
  deleteImportLog,
  deleteQueueItem,
  enqueueBatchItems,
  eraseQueueItemOnSuccess,
  formatCountdown,
  isItemReadyForRetry,
  loadUserImportLogs,
  loadUserImportQueue,
  MAX_RETRY_ATTEMPTS,
  recordQueueItemFailure,
  resetQueueItemForRetry,
  saveImportSessionLog,
  setQueueItemProcessing,
} from './import-queue.js?v=5';
import { saveRecipe } from './recipes.js?v=5';
import { buildBatchQueue, normalizeReelUrl, parseWhatsAppExport } from './whatsapp-parser.js?v=5';

export {
  buildBatchQueue,
  clearAllUnparsableItems,
  deleteImportLog,
  deleteQueueItem,
  enqueueBatchItems,
  eraseQueueItemOnSuccess,
  formatCountdown,
  isItemReadyForRetry,
  loadUserImportLogs,
  loadUserImportQueue,
  MAX_RETRY_ATTEMPTS,
  normalizeReelUrl,
  parseWhatsAppExport,
  recordQueueItemFailure,
  resetQueueItemForRetry,
  saveImportSessionLog,
};

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
 * Process a batch queue sequentially with Firestore persistence:
 * 1. Writes items into Firestore `importQueue` before parsing.
 * 2. If a recipe already exists in the library, it is skipped and logged to prevent overwrite.
 *    Any existing queue doc for it is cleaned up.
 * 3. Newly extracted recipes are saved to Firestore, and ERASED immediately from `importQueue`.
 * 4. Failed/blocked items record failure count and schedule next retry in 10 minutes.
 * 5. Items failing 10 times are marked as 'unparsable'.
 * 6. Session execution log is persisted in `importLogs` for historical tracking.
 *
 * @param {string} ownerUid
 * @param {Array<Object>} queueItems
 * @param {Function} [onProgress]
 * @param {Array<Object>} [existingRecipes]
 * @param {boolean} [alreadyEnqueued] - True if items are already documents in importQueue
 */
export async function processBatchQueue(
  ownerUid,
  queueItems,
  onProgress,
  existingRecipes = [],
  alreadyEnqueued = false
) {
  const existingMap = new Map();
  for (const r of existingRecipes) {
    if (r.sourceUrl) {
      existingMap.set(normalizeReelUrl(r.sourceUrl), r);
    }
  }

  // 1. Ensure all items are written down to Firestore importQueue before parsing
  let itemsToProcess = queueItems;
  if (!alreadyEnqueued) {
    onProgress?.({
      type: 'wake',
      message: `Writing ${queueItems.length} URL(s) to database queue...`,
    });
    try {
      const enqueueRes = await enqueueBatchItems(ownerUid, queueItems, existingRecipes);
      // If we enqueued fresh items, use the saved docs with their Firestore IDs
      if (enqueueRes.items && enqueueRes.items.length > 0) {
        itemsToProcess = enqueueRes.items;
      }
    } catch (err) {
      console.warn('Queue persistence notice:', err);
    }
  }

  await wakeBackend((msg) => onProgress?.({ type: 'wake', message: msg }));

  const summary = {
    saved: 0,
    skipped: 0,
    blocked: [],
    failed: [],
    unparsable: [],
  };
  const sessionLogDetails = [];

  for (let i = 0; i < itemsToProcess.length; i += 1) {
    const item = itemsToProcess[i];
    const normUrl = normalizeReelUrl(item.url);

    // 2. Check if recipe ALREADY EXISTS in active library
    const existing = item.existingRecipe || existingMap.get(normUrl);
    if (existing) {
      summary.skipped += 1;
      // Erase from queue table if it was there since it's already in recipes
      if (item.id) {
        try {
          await eraseQueueItemOnSuccess(item.id);
        } catch (_) {}
      }
      const msg = `Recipe already exists ("${existing.title}") - skipped to prevent overwrite.`;
      sessionLogDetails.push({
        url: item.url,
        status: 'skipped',
        title: existing.title,
        message: msg,
        timestamp: Date.now(),
      });
      onProgress?.({
        type: 'item_done',
        index: i,
        total: itemsToProcess.length,
        status: 'skipped',
        url: item.url,
        title: existing.title || 'Untitled',
        message: msg,
      });
      continue;
    }

    // 3. Mark as processing in Firestore queue
    if (item.id) {
      try {
        await setQueueItemProcessing(item.id);
      } catch (_) {}
    }

    onProgress?.({
      type: 'item_start',
      index: i,
      total: itemsToProcess.length,
      url: item.url,
      attempts: item.attempts || 0,
    });

    try {
      const outcome = await extractReel(item.url, item.context || '');

      if (outcome.status === 'blocked_fallback_required') {
        let nextInfo = null;
        if (item.id) {
          try {
            nextInfo = await recordQueueItemFailure(
              item.id,
              item.attempts || 0,
              outcome.message,
              item.history || []
            );
          } catch (_) {}
        }
        const isUnparsable = nextInfo?.status === 'unparsable';
        const failureEntry = {
          ...item,
          message: outcome.message,
          attempts: nextInfo?.attempts || (item.attempts || 0) + 1,
          status: isUnparsable ? 'unparsable' : 'blocked',
        };

        if (isUnparsable) {
          summary.unparsable.push(failureEntry);
        } else {
          summary.blocked.push(failureEntry);
        }

        sessionLogDetails.push({
          url: item.url,
          status: isUnparsable ? 'unparsable' : 'blocked',
          message: outcome.message,
          attempts: failureEntry.attempts,
          timestamp: Date.now(),
        });

        onProgress?.({
          type: 'item_done',
          index: i,
          total: itemsToProcess.length,
          status: isUnparsable ? 'unparsable' : 'blocked',
          url: item.url,
          message: outcome.message,
          attempts: failureEntry.attempts,
        });
      } else if (outcome.recipe) {
        // Save extracted recipe to Firestore recipes collection
        await saveRecipe(ownerUid, outcome.recipe);
        summary.saved += 1;
        existingMap.set(normUrl, outcome.recipe);

        // Erase successful item from queue table immediately
        if (item.id) {
          try {
            await eraseQueueItemOnSuccess(item.id);
          } catch (_) {}
        }

        sessionLogDetails.push({
          url: item.url,
          status: 'saved',
          title: outcome.recipe.title,
          timestamp: Date.now(),
        });

        onProgress?.({
          type: 'item_done',
          index: i,
          total: itemsToProcess.length,
          status: 'saved',
          url: item.url,
          title: outcome.recipe.title,
        });
      }
    } catch (err) {
      let nextInfo = null;
      if (item.id) {
        try {
          nextInfo = await recordQueueItemFailure(
            item.id,
            item.attempts || 0,
            err.message,
            item.history || []
          );
        } catch (_) {}
      }
      const isUnparsable = nextInfo?.status === 'unparsable';
      const failureEntry = {
        ...item,
        message: err.message,
        attempts: nextInfo?.attempts || (item.attempts || 0) + 1,
        status: isUnparsable ? 'unparsable' : 'failed',
      };

      if (isUnparsable) {
        summary.unparsable.push(failureEntry);
      } else {
        summary.failed.push(failureEntry);
      }

      sessionLogDetails.push({
        url: item.url,
        status: isUnparsable ? 'unparsable' : 'failed',
        message: err.message,
        attempts: failureEntry.attempts,
        timestamp: Date.now(),
      });

      onProgress?.({
        type: 'item_done',
        index: i,
        total: itemsToProcess.length,
        status: isUnparsable ? 'unparsable' : 'failed',
        url: item.url,
        message: err.message,
        attempts: failureEntry.attempts,
      });
    }
  }

  // 4. Save batch session execution log to Firestore importLogs
  try {
    const sessionLogId = await saveImportSessionLog(ownerUid, {
      totalUrls: itemsToProcess.length,
      savedCount: summary.saved,
      skippedCount: summary.skipped,
      failedCount: summary.failed.length,
      blockedCount: summary.blocked.length,
      unparsableCount: summary.unparsable.length,
      summaryText: `Batch complete: ${summary.saved} saved, ${summary.skipped} skipped, ${summary.failed.length} failed, ${summary.blocked.length} blocked, ${summary.unparsable.length} unparsable.`,
      details: sessionLogDetails,
    });
    summary.sessionLogId = sessionLogId;
  } catch (err) {
    console.warn('Failed saving import session log:', err);
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
  return {
    recipes: payload.recipes || [],
    unparsed: payload.unparsed || [],
    filename: payload.filename || file.name,
  };
}
