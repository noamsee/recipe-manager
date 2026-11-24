/**
 * Pure algorithmic helpers and constants for the Persistent Batch Import Queue,
 * 10-minute retry scheduling, unparsable status threshold, and attempt logs.
 * Zero network / Firebase dependencies so this is 100% testable in Node and browser.
 */

export const QUEUE_COLLECTION = 'importQueue';
export const LOGS_COLLECTION = 'importLogs';
export const MAX_RETRY_ATTEMPTS = 10;
export const RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes (600,000 ms)

/**
 * Check if a queue item is eligible for extraction retry right now.
 *
 * @param {Object} item
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isItemReadyForRetry(item, nowMs = Date.now()) {
  if (!item || item.status === 'unparsable' || item.status === 'processing') return false;
  if (item.status === 'pending') return true;
  if (item.status === 'failed') {
    return !item.nextRetryAt || Number(item.nextRetryAt) <= nowMs;
  }
  return false;
}

/**
 * Calculate the next attempt count, status ('failed' or 'unparsable'),
 * and next retry timestamp (epoch ms) after an extraction failure.
 *
 * @param {number} currentAttempts
 * @param {number} [maxAttempts]
 * @param {number} [delayMs]
 * @param {number} [nowMs]
 * @returns {{ status: 'failed' | 'unparsable', attempts: number, nextRetryAt: number | null }}
 */
export function computeNextStatusAndRetry(
  currentAttempts,
  maxAttempts = MAX_RETRY_ATTEMPTS,
  delayMs = RETRY_DELAY_MS,
  nowMs = Date.now()
) {
  const newAttempts = Math.max(1, (Number(currentAttempts) || 0) + 1);
  if (newAttempts >= maxAttempts) {
    return {
      status: 'unparsable',
      attempts: newAttempts,
      nextRetryAt: null,
    };
  }
  return {
    status: 'failed',
    attempts: newAttempts,
    nextRetryAt: nowMs + delayMs,
  };
}

/**
 * Format remaining milliseconds into human-readable countdown e.g. "9m 45s" or "32s".
 *
 * @param {number} msRemaining
 * @returns {string}
 */
export function formatCountdown(msRemaining) {
  if (msRemaining <= 0) return 'Ready to retry';
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * Classify a list of queue items into semantic groups for the UI and scheduler.
 *
 * @param {Array<Object>} items
 * @param {number} [nowMs]
 * @returns {{
 *   ready: Array<Object>,
 *   waiting: Array<Object>,
 *   unparsable: Array<Object>,
 *   processing: Array<Object>,
 *   total: number
 * }}
 */
export function classifyQueueItems(items = [], nowMs = Date.now()) {
  const ready = [];
  const waiting = [];
  const unparsable = [];
  const processing = [];

  for (const item of items) {
    if (!item) continue;
    if (item.status === 'processing') {
      processing.push(item);
    } else if (item.status === 'unparsable' || (item.attempts && item.attempts >= MAX_RETRY_ATTEMPTS)) {
      unparsable.push(item);
    } else if (item.status === 'pending') {
      ready.push(item);
    } else if (item.status === 'failed') {
      if (!item.nextRetryAt || Number(item.nextRetryAt) <= nowMs) {
        ready.push(item);
      } else {
        waiting.push(item);
      }
    }
  }

  // Sort waiting by shortest remaining time first
  waiting.sort((a, b) => (Number(a.nextRetryAt) || 0) - (Number(b.nextRetryAt) || 0));

  return {
    ready,
    waiting,
    unparsable,
    processing,
    total: items.length,
  };
}

/**
 * Format an attempt record for appending to the item's history.
 *
 * @param {number} attempt
 * @param {string} error
 * @param {number} [timestamp]
 * @returns {{ attempt: number, timestamp: number, error: string }}
 */
export function createAttemptRecord(attempt, error, timestamp = Date.now()) {
  return {
    attempt: Number(attempt) || 1,
    timestamp: Number(timestamp) || Date.now(),
    error: String(error || 'Extraction failed').slice(0, 300),
  };
}
