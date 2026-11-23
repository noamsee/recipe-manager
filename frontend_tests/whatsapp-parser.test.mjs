import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchQueue, normalizeReelUrl, parseWhatsAppExport } from '../js/whatsapp-parser.js';

test('normalizeReelUrl strips tracking query params, stkn, mibextid, and trailing punctuation', () => {
  const igCleaned = normalizeReelUrl('https://www.instagram.com/reel/DeFjLpABrfw/?stkn=MTBsNGw2M2h3c3A5ZA==');
  assert.equal(igCleaned, 'https://www.instagram.com/reel/DeFjLpABrfw/');

  const fbCleaned = normalizeReelUrl('https://m.facebook.com/share/v/1BoViagDae/?mibextid=wwXIfr');
  assert.equal(fbCleaned, 'https://www.facebook.com/share/v/1BoViagDae/');
});

test('parseWhatsAppExport extracts Facebook and Instagram links, strips prefixes, and deduplicates', () => {
  const sampleChat = [
    '[12/11/2026, 10:15:00] Noam: פסטה מטורפת https://www.instagram.com/reel/XYZ999/?igsh=abc',
    '12/11/2026, 10:20 - Noam: https://www.facebook.com/share/r/123456/ חובה לנסות',
    '12/11/2026, 10:21 - Noam: https://www.instagram.com/reel/XYZ999/',
    '12/11/2026, 10:22 - Noam: https://fb.watch/coolvideo/',
    '12/11/2026, 10:25 - Noam: https://www.instagram.com/reel/ALREADY1/',
  ].join('\n');

  const existing = new Set(['https://www.instagram.com/reel/ALREADY1/?utm_source=ig_web']);
  const result = parseWhatsAppExport(sampleChat, existing);

  assert.equal(result.items.length, 3);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.alreadySavedCount, 1);
  assert.equal(result.items[0].url, 'https://www.instagram.com/reel/XYZ999/');
  assert.equal(result.items[0].context, 'פסטה מטורפת');
  assert.equal(result.items[1].url, 'https://www.facebook.com/share/r/123456/');
  assert.equal(result.items[1].context, 'חובה לנסות');
  assert.equal(result.items[2].url, 'https://fb.watch/coolvideo/');
});

test('buildBatchQueue identifies already saved recipes to prevent overwrite', () => {
  const existingRecipes = [
    { title: 'Puff Pastry Salmon Appetizer', sourceUrl: 'https://www.facebook.com/share/v/1BoViagDae/?mibextid=wwXIfr' },
    { title: 'Bagel Recipe', sourceUrl: 'https://www.instagram.com/reel/DeFjLpABrfw/' },
  ];

  const urlsText = [
    'https://www.facebook.com/share/v/1BoViagDae/', // Already exists
    'https://www.instagram.com/reel/NEW_RECIPE_123/', // New
  ].join('\n');

  const queue = buildBatchQueue({ urlsText, existingRecipes, includeAlreadySaved: true });
  assert.equal(queue.items.length, 2);
  assert.equal(queue.alreadySavedCount, 1);
  assert.equal(queue.items[0].existingRecipe?.title, 'Puff Pastry Salmon Appetizer');
  assert.equal(queue.items[1].existingRecipe, null);
});
