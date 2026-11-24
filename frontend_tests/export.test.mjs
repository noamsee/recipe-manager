import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterRecipesForExport,
  generateCookbookHtml,
  recipesToJson,
  recipesToMarkdown,
} from '../js/export.js';

const mockRecipes = [
  {
    id: 'r1',
    title: 'שקשוקה חריפה',
    language: 'he',
    category: 'Breakfast',
    servings: 2,
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    dietary: ['parve', 'vegetarian'],
    tags: ['quick', 'spicy'],
    sourceUrl: 'https://www.instagram.com/reel/ABC/',
    thumbnailDataUri: 'data:image/jpeg;base64,mockImage1',
    ingredients: [{ name: 'עגבניות', amount: '4', unit: '' }],
    steps: ['מטגנים שום ומוסיפים עגבניות'],
    notes: 'טעים עם חלה',
  },
  {
    id: 'r2',
    title: 'Chocolate Lava Cake',
    language: 'en',
    category: 'Dessert',
    servings: 4,
    dietary: ['dairy'],
    tags: ['baking', 'chocolate'],
    thumbnailDataUri: 'data:image/jpeg;base64,mockImage2',
    ingredients: [{ name: 'Dark chocolate', amount: '200', unit: 'g' }],
    steps: ['Melt chocolate', 'Bake 12 mins at 200C'],
    notes: 'Serve warm',
  },
  {
    id: 'r3',
    title: 'Vegan Lentil Soup',
    language: 'en',
    category: 'Soup',
    servings: 6,
    dietary: ['vegan', 'gluten-free'],
    tags: ['healthy', 'quick'],
    thumbnailDataUri: '',
    ingredients: [{ name: 'Red lentils', amount: '1', unit: 'cup' }],
    steps: ['Boil lentils with spices for 25 mins'],
  },
];

test('recipesToJson and recipesToMarkdown preserve Hebrew/English recipe structure', () => {
  const json = JSON.parse(recipesToJson(mockRecipes));
  assert.equal(json.count, 3);
  assert.equal(json.recipes[0].title, 'שקשוקה חריפה');

  const md = recipesToMarkdown([mockRecipes[0]]);
  assert.match(md, /# שקשוקה חריפה/);
  assert.match(md, /- 4 עגבניות/);
  assert.match(md, /1\. מטגנים שום ומוסיפים עגבניות/);
  assert.match(md, /Source: https:\/\/www\.instagram\.com\/reel\/ABC\//);
});

test('filterRecipesForExport filters by category, dietary, tags, and language', () => {
  // Filter by category
  const desserts = filterRecipesForExport(mockRecipes, { category: 'Dessert' });
  assert.equal(desserts.length, 1);
  assert.equal(desserts[0].id, 'r2');

  // Filter by dietary
  const vegans = filterRecipesForExport(mockRecipes, { dietary: 'vegan' });
  assert.equal(vegans.length, 1);
  assert.equal(vegans[0].id, 'r3');

  // Filter by custom tag
  const quickItems = filterRecipesForExport(mockRecipes, { tag: 'quick' });
  assert.equal(quickItems.length, 2);
  assert.deepEqual(quickItems.map((r) => r.id), ['r1', 'r3']);

  // Filter by language
  const hebrewItems = filterRecipesForExport(mockRecipes, { language: 'he' });
  assert.equal(hebrewItems.length, 1);
  assert.equal(hebrewItems[0].title, 'שקשוקה חריפה');

  // Combined filters
  const combined = filterRecipesForExport(mockRecipes, { category: 'Breakfast', tag: 'spicy' });
  assert.equal(combined.length, 1);
  assert.equal(combined[0].id, 'r1');

  // No match
  const none = filterRecipesForExport(mockRecipes, { category: 'Meat' });
  assert.equal(none.length, 0);
});

test('generateCookbookHtml embeds photos, sets RTL direction for Hebrew, and includes page breaks', () => {
  const html = generateCookbookHtml(mockRecipes, { title: 'Family Favorites' });

  // Title & Table of contents
  assert.match(html, /Family Favorites/);
  assert.match(html, /Table of Contents \(3\)/);
  assert.match(html, /שקשוקה חריפה/);
  assert.match(html, /Chocolate Lava Cake/);

  // Photos embedded
  assert.match(html, /src="data:image\/jpeg;base64,mockImage1"/);
  assert.match(html, /src="data:image\/jpeg;base64,mockImage2"/);

  // Hebrew RTL direction
  assert.match(html, /dir="rtl" lang="he"/);
  assert.match(html, /מצרכים/);
  assert.match(html, /הוראות הכנה/);

  // English LTR direction
  assert.match(html, /dir="ltr" lang="en"/);
  assert.match(html, /Instructions/);

  // Print page-break CSS
  assert.match(html, /page-break-after: always/);
  assert.match(html, /window\.print\(\)/);
});
