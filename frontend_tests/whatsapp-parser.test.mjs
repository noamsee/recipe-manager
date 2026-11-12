import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReelUrl, parseWhatsAppExport } from '../js/whatsapp-parser.js';

test('normalizeReelUrl strips tracking query params and trailing punctuation', () => {
  const cleaned = normalizeReelUrl('https://www.instagram.com/reel/ABC123/?igsh=xyz123,');
  assert.equal(cleaned, 'https://www.instagram.com/reel/ABC123/');
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
