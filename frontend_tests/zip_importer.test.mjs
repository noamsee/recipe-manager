import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
globalThis.JSZip = require('../js/vendor/jszip.min.js');

import {
  extractRecipesFromZip,
  parseRecipeText,
  validateZipArchive,
} from '../js/zip-importer.js';

test('parseRecipeText structures Hebrew recipe with ingredients, steps, and servings', () => {
  const sample = `
מרק פטריות וגריסים עם גזר
מרכיבים
כ 10-מנות
• 3 גזרים
• 4 שיני שום
• 2 כפות שמן זית
אופן ההכנה
.1 חותכים את הגזר והשום לקוביות קטנות.
.2 מחממים שמן ומטגנים.
.3 מבשלים כ 30 דקות עד שהגריסים רכים.
טיפים ושדרוגים
• אפשר להחליף את הגריסים באורז.
From <http://example.com/recipe>
  `.trim();

  const parsed = parseRecipeText(sample, 'מרק פטריות', 'מרקים');
  assert.equal(parsed.title, 'מרק פטריות');
  assert.equal(parsed.servings, 10);
  assert.equal(parsed.ingredients.length, 3);
  assert.equal(parsed.ingredients[0].name, '3 גזרים');
  assert.equal(parsed.steps.length, 3);
  assert.match(parsed.steps[0], /חותכים את הגזר/);
  assert.match(parsed.notes, /אפשר להחליף/);
  assert.equal(parsed.sourceUrl, 'http://example.com/recipe');
});

test('validateZipArchive rejects invalid non-zip buffer', async () => {
  const fakeData = Buffer.from('Not a zip file content');
  const res = await validateZipArchive(fakeData);
  assert.equal(res.valid, false);
  assert.match(res.error, /not a valid ZIP archive/i);
});

test('validateZipArchive rejects zip without recipes.json', async () => {
  const zip = new globalThis.JSZip();
  zip.file('hello.txt', 'Hello world');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const res = await validateZipArchive(buf);
  assert.equal(res.valid, false);
  assert.match(res.error, /must contain a "recipes.json" file/i);
});

test('validateZipArchive rejects recipes.json with invalid JSON syntax', async () => {
  const zip = new globalThis.JSZip();
  zip.file('recipes.json', '{ broken json ');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const res = await validateZipArchive(buf);
  assert.equal(res.valid, false);
  assert.match(res.error, /not valid JSON/i);
});

test('validateZipArchive rejects empty recipes array', async () => {
  const zip = new globalThis.JSZip();
  zip.file('recipes.json', '[]');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  const res = await validateZipArchive(buf);
  assert.equal(res.valid, false);
  assert.match(res.error, /does not contain any recipe entries/i);
});

test('validateZipArchive and extractRecipesFromZip successfully process soups.zip sample', async () => {
  const zipPath = 'assets/samples/soups.zip';
  assert.ok(fs.existsSync(zipPath), 'soups.zip exists');
  const fileBuf = fs.readFileSync(zipPath);

  const validation = await validateZipArchive(fileBuf);
  assert.equal(validation.valid, true);
  assert.equal(validation.recipesRaw.length, 10);
  assert.ok(validation.imageCount > 0);

  const { recipes, total } = await extractRecipesFromZip(fileBuf);
  assert.equal(total, 10);
  assert.equal(recipes.length, 10);

  const r1 = recipes[0];
  assert.equal(r1.title, 'מרק פטריות וגריסים עם גזר');
  assert.equal(r1.category, 'מרקים');
  assert.equal(r1.language, 'he');
  assert.equal(r1.source, 'OneNote (PDF)');
  assert.ok(r1.ingredients.length > 0);
  assert.ok(r1.steps.length > 0);
  assert.ok(r1.thumbnailDataUri.startsWith('data:image/jpeg;base64,'));
});
