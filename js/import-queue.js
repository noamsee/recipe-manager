/**
 * Persistent Batch Import Queue & Import Attempt Logs Firestore Service.
 *
 * Requirements fulfilled:
 * 1. Writes all batch import URLs to Firestore (`importQueue`) before attempting extraction.
 * 2. Successfully extracted recipes are erased immediately from the queue table (`deleteDoc`).
 * 3. Failed items are scheduled for automatic retry after a 10-minute cooldown (attempts < 10).
 * 4. Items failing 10 times are marked as 'unparsable' and stopped from auto-retrying.
 * 5. Import session logs are preserved in `importLogs` for historical review.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';
import { getFirebaseServices } from './firebase-client.js?v=5';
import {
  classifyQueueItems,
  computeNextStatusAndRetry,
  createAttemptRecord,
  formatCountdown,
  isItemReadyForRetry,
  LOGS_COLLECTION,
  MAX_RETRY_ATTEMPTS,
  QUEUE_COLLECTION,
  RETRY_DELAY_MS,
} from './import-queue-logic.js?v=5';
import { normalizeReelUrl } from './whatsapp-parser.js?v=5';

export {
  classifyQueueItems,
  computeNextStatusAndRetry,
  createAttemptRecord,
  formatCountdown,
  isItemReadyForRetry,
  LOGS_COLLECTION,
  MAX_RETRY_ATTEMPTS,
  QUEUE_COLLECTION,
  RETRY_DELAY_MS,
};

/**
 * Enqueue a list of items into Firestore `importQueue`.
 * Skips items that already exist in active recipes library or are already in the queue.
 *
 * @param {string} ownerUid
 * @param {Array<{ url: string, context?: string, originalUrl?: string }>} items
 * @param {Array<Object>} existingRecipes
 * @returns {Promise<{ enqueued: number, skippedExisting: number, alreadyInQueue: number, items: Array<Object> }>}
 */
export async function enqueueBatchItems(ownerUid, items, existingRecipes = []) {
  const { db } = getFirebaseServices();

  const existingRecipeUrls = new Set(
    existingRecipes
      .map((r) => r.sourceUrl)
      .filter(Boolean)
      .map((u) => normalizeReelUrl(u))
  );

  // Fetch current user import queue to avoid duplicate documents
  const existingQueueSnap = await getDocs(
    query(collection(db, QUEUE_COLLECTION), where('ownerUid', '==', ownerUid))
  );
  const existingQueueUrls = new Map();
  existingQueueSnap.forEach((d) => {
    const data = d.data();
    if (data.url) {
      existingQueueUrls.set(normalizeReelUrl(data.url), d.id);
    }
  });

  const enqueuedItems = [];
  let skippedExisting = 0;
  let alreadyInQueue = 0;
  const seenInBatch = new Set();

  for (const rawItem of items) {
    const norm = normalizeReelUrl(rawItem.url);
    if (!norm || seenInBatch.has(norm)) continue;
    seenInBatch.add(norm);

    if (existingRecipeUrls.has(norm)) {
      skippedExisting += 1;
      continue;
    }

    if (existingQueueUrls.has(norm)) {
      alreadyInQueue += 1;
      continue;
    }

    const docRef = doc(collection(db, QUEUE_COLLECTION));
    const docData = {
      ownerUid,
      url: norm,
      originalUrl: rawItem.originalUrl || rawItem.url,
      context: rawItem.context || '',
      status: 'pending',
      attempts: 0,
      lastError: '',
      lastAttemptAt: null,
      nextRetryAt: 0, // ready immediately
      history: [],
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(docRef, docData);
    enqueuedItems.push({ id: docRef.id, ...docData });
  }

  return {
    enqueued: enqueuedItems.length,
    skippedExisting,
    alreadyInQueue,
    items: enqueuedItems,
  };
}

/**
 * Fetch all items in user's import queue.
 *
 * @param {string} ownerUid
 * @returns {Promise<Array<Object>>}
 */
export async function loadUserImportQueue(ownerUid) {
  const { db } = getFirebaseServices();
  const q = query(
    collection(db, QUEUE_COLLECTION),
    where('ownerUid', '==', ownerUid)
  );
  const snap = await getDocs(q);
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Sort: pending first, then failed by nextRetryAt, then unparsable
  return items.sort((a, b) => {
    if (a.status === 'unparsable' && b.status !== 'unparsable') return 1;
    if (a.status !== 'unparsable' && b.status === 'unparsable') return -1;
    return (Number(a.nextRetryAt) || 0) - (Number(b.nextRetryAt) || 0);
  });
}

/**
 * Mark a queue item as currently processing.
 *
 * @param {string} itemId
 */
export async function setQueueItemProcessing(itemId) {
  const { db } = getFirebaseServices();
  await updateDoc(doc(db, QUEUE_COLLECTION, itemId), {
    status: 'processing',
    updatedAt: serverTimestamp(),
  });
}

/**
 * Erase a successfully parsed item from `importQueue`.
 * (Per user specification: "all the successfull ones it will erase from the table").
 *
 * @param {string} itemId
 */
export async function eraseQueueItemOnSuccess(itemId) {
  if (!itemId) return;
  const { db } = getFirebaseServices();
  await deleteDoc(doc(db, QUEUE_COLLECTION, itemId));
}

/**
 * Record a failure on a queue item, increment attempts, and schedule next retry in 10 minutes.
 * If 10 attempts reached, status becomes 'unparsable'.
 *
 * @param {string} itemId
 * @param {number} currentAttempts
 * @param {string} errorMessage
 * @param {Array<Object>} [existingHistory]
 */
export async function recordQueueItemFailure(
  itemId,
  currentAttempts,
  errorMessage,
  existingHistory = []
) {
  if (!itemId) return null;
  const { db } = getFirebaseServices();
  const next = computeNextStatusAndRetry(currentAttempts, MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS);

  const attemptEntry = createAttemptRecord(next.attempts, errorMessage);
  const updatedHistory = [...(existingHistory || []), attemptEntry].slice(-15);

  await updateDoc(doc(db, QUEUE_COLLECTION, itemId), {
    status: next.status,
    attempts: next.attempts,
    lastError: attemptEntry.error,
    lastAttemptAt: serverTimestamp(),
    nextRetryAt: next.nextRetryAt,
    history: updatedHistory,
    updatedAt: serverTimestamp(),
  });

  return next;
}

/**
 * Reset an unparsable or failed item so it can be retried immediately from attempt 0.
 *
 * @param {string} itemId
 */
export async function resetQueueItemForRetry(itemId) {
  if (!itemId) return;
  const { db } = getFirebaseServices();
  await updateDoc(doc(db, QUEUE_COLLECTION, itemId), {
    status: 'pending',
    attempts: 0,
    nextRetryAt: 0,
    lastError: '',
    updatedAt: serverTimestamp(),
  });
}

/**
 * Delete a specific queue item (dismiss).
 *
 * @param {string} itemId
 */
export async function deleteQueueItem(itemId) {
  if (!itemId) return;
  const { db } = getFirebaseServices();
  await deleteDoc(doc(db, QUEUE_COLLECTION, itemId));
}

/**
 * Clear all unparsable items for this user.
 *
 * @param {string} ownerUid
 */
export async function clearAllUnparsableItems(ownerUid) {
  const { db } = getFirebaseServices();
  const q = query(
    collection(db, QUEUE_COLLECTION),
    where('ownerUid', '==', ownerUid),
    where('status', '==', 'unparsable')
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/**
 * Persist an import session execution log for historical tracking and review.
 *
 * @param {string} ownerUid
 * @param {Object} sessionData
 */
export async function saveImportSessionLog(ownerUid, sessionData) {
  const { db } = getFirebaseServices();
  const logRef = doc(collection(db, LOGS_COLLECTION));
  const logData = {
    ownerUid,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
    totalUrls: sessionData.totalUrls || 0,
    savedCount: sessionData.savedCount || 0,
    skippedCount: sessionData.skippedCount || 0,
    failedCount: sessionData.failedCount || 0,
    blockedCount: sessionData.blockedCount || 0,
    unparsableCount: sessionData.unparsableCount || 0,
    summaryText: sessionData.summaryText || '',
    details: (sessionData.details || []).slice(0, 100), // preserve detailed events
  };
  await setDoc(logRef, logData);
  return logRef.id;
}

/**
 * Load the user's previous import attempt logs, ordered newest to oldest.
 *
 * @param {string} ownerUid
 * @param {number} [maxCount]
 * @returns {Promise<Array<Object>>}
 */
export async function loadUserImportLogs(ownerUid, maxCount = 25) {
  const { db } = getFirebaseServices();
  const q = query(
    collection(db, LOGS_COLLECTION),
    where('ownerUid', '==', ownerUid),
    orderBy('createdAtMs', 'desc'),
    limit(maxCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Delete a specific import log entry.
 *
 * @param {string} logId
 */
export async function deleteImportLog(logId) {
  if (!logId) return;
  const { db } = getFirebaseServices();
  await deleteDoc(doc(db, LOGS_COLLECTION, logId));
}
