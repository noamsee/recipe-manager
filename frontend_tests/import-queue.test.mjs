import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  classifyQueueItems,
  computeNextStatusAndRetry,
  createAttemptRecord,
  formatCountdown,
  isItemReadyForRetry,
} from '../js/import-queue-logic.js';

test('isItemReadyForRetry identifies eligible items based on status and nextRetryAt', () => {
  const now = 1700000000000;

  // Pending item is always ready
  assert.equal(isItemReadyForRetry({ status: 'pending' }, now), true);

  // Failed item with past nextRetryAt is ready
  assert.equal(isItemReadyForRetry({ status: 'failed', nextRetryAt: now - 1000 }, now), true);
  assert.equal(isItemReadyForRetry({ status: 'failed', nextRetryAt: now }, now), true);

  // Failed item with future nextRetryAt is NOT ready
  assert.equal(isItemReadyForRetry({ status: 'failed', nextRetryAt: now + 5000 }, now), false);

  // Unparsable item is NEVER ready
  assert.equal(isItemReadyForRetry({ status: 'unparsable', nextRetryAt: now - 1000 }, now), false);

  // Processing item is NOT ready
  assert.equal(isItemReadyForRetry({ status: 'processing', nextRetryAt: now - 1000 }, now), false);

  // Null/undefined item
  assert.equal(isItemReadyForRetry(null, now), false);
});

test('computeNextStatusAndRetry sets 10-minute retry for attempts < 10', () => {
  const now = 1700000000000;

  // Attempt 1 failure: status failed, retry in 10 minutes
  const res1 = computeNextStatusAndRetry(0, MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS, now);
  assert.equal(res1.status, 'failed');
  assert.equal(res1.attempts, 1);
  assert.equal(res1.nextRetryAt, now + 10 * 60 * 1000);

  // Attempt 9 failure: status failed, attempts 9, retry in 10 minutes
  const res9 = computeNextStatusAndRetry(8, MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS, now);
  assert.equal(res9.status, 'failed');
  assert.equal(res9.attempts, 9);
  assert.equal(res9.nextRetryAt, now + 10 * 60 * 1000);
});

test('computeNextStatusAndRetry sets unparsable status when 10 attempts are reached', () => {
  const now = 1700000000000;

  // 10th attempt failure -> marked 'unparsable', nextRetryAt null
  const res10 = computeNextStatusAndRetry(9, MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS, now);
  assert.equal(res10.status, 'unparsable');
  assert.equal(res10.attempts, 10);
  assert.equal(res10.nextRetryAt, null);

  // Subsequent failure also remains unparsable
  const res11 = computeNextStatusAndRetry(10, MAX_RETRY_ATTEMPTS, RETRY_DELAY_MS, now);
  assert.equal(res11.status, 'unparsable');
  assert.equal(res11.attempts, 11);
  assert.equal(res11.nextRetryAt, null);
});

test('formatCountdown formats remaining milliseconds cleanly', () => {
  assert.equal(formatCountdown(0), 'Ready to retry');
  assert.equal(formatCountdown(-5000), 'Ready to retry');
  assert.equal(formatCountdown(45000), '45s');
  assert.equal(formatCountdown(59000), '59s');
  assert.equal(formatCountdown(60000), '1m 00s');
  assert.equal(formatCountdown(585000), '9m 45s');
  assert.equal(formatCountdown(600000), '10m 00s');
});

test('classifyQueueItems partitions items into ready, waiting, unparsable, and processing', () => {
  const now = 1700000000000;
  const items = [
    { id: '1', status: 'pending' },
    { id: '2', status: 'failed', nextRetryAt: now - 5000, attempts: 2 },
    { id: '3', status: 'failed', nextRetryAt: now + 300000, attempts: 1 }, // waiting 5 mins
    { id: '4', status: 'failed', nextRetryAt: now + 120000, attempts: 3 }, // waiting 2 mins
    { id: '5', status: 'unparsable', attempts: 10 },
    { id: '6', status: 'processing' },
  ];

  const classified = classifyQueueItems(items, now);

  assert.equal(classified.ready.length, 2); // 1 (pending) + 2 (failed with past cooldown)
  assert.deepEqual(classified.ready.map((i) => i.id), ['1', '2']);

  assert.equal(classified.waiting.length, 2);
  // Waiting should be sorted by shortest remaining time first (id '4' before '3')
  assert.deepEqual(classified.waiting.map((i) => i.id), ['4', '3']);

  assert.equal(classified.unparsable.length, 1);
  assert.equal(classified.unparsable[0].id, '5');

  assert.equal(classified.processing.length, 1);
  assert.equal(classified.processing[0].id, '6');
  assert.equal(classified.total, 6);
});

test('createAttemptRecord bounds error message length and retains timestamp', () => {
  const now = 1700000000000;
  const longError = 'x'.repeat(500);
  const rec = createAttemptRecord(3, longError, now);

  assert.equal(rec.attempt, 3);
  assert.equal(rec.timestamp, now);
  assert.equal(rec.error.length, 300);
});
