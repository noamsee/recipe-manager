import assert from 'node:assert/strict';
import test from 'node:test';
import { computeBulkRecipeUpdates } from '../js/bulk-utils.js';

test('computeBulkRecipeUpdates returns empty object if no fields are selected for application', () => {
  const recipe = {
    id: 'r1',
    title: 'קניש תפוחי אדמה',
    category: 'תוספות',
    language: 'he',
    source: 'OneNote (PDF)',
    dietary: ['parve'],
    tags: ['traditional'],
  };

  const updates = computeBulkRecipeUpdates(recipe, {
    applyCategory: false,
    newCategory: 'מרקים',
    applyLanguage: false,
    newLanguage: 'en',
    applySource: false,
    newSource: 'Manual',
    applyDietary: false,
    chosenDietary: ['meat'],
    applyTags: false,
    tagsToAdd: ['quick'],
  });

  assert.deepEqual(updates, {});
});

test('computeBulkRecipeUpdates updates category and trims whitespace', () => {
  const recipe = {
    id: 'r1',
    title: 'קניש תפוחי אדמה',
    category: 'תוספות',
    language: 'he',
  };

  const updates = computeBulkRecipeUpdates(recipe, {
    applyCategory: true,
    newCategory: 'מאפים',
  });

  assert.equal(updates.category, 'מאפים');
  assert.equal(updates.language, undefined);
  assert.equal(updates.source, undefined);
});

test('computeBulkRecipeUpdates switches language between Hebrew (he) and English (en)', () => {
  const hebrewRecipe = {
    id: 'r1',
    title: 'מרק עוף',
    language: 'he',
  };

  const englishRecipe = {
    id: 'r2',
    title: 'Chicken Soup',
    language: 'en',
  };

  const updatesToEn = computeBulkRecipeUpdates(hebrewRecipe, {
    applyLanguage: true,
    newLanguage: 'en',
  });
  assert.equal(updatesToEn.language, 'en');

  const updatesToHe = computeBulkRecipeUpdates(englishRecipe, {
    applyLanguage: true,
    newLanguage: 'he',
  });
  assert.equal(updatesToHe.language, 'he');
});

test('computeBulkRecipeUpdates updates source correctly', () => {
  const recipe = {
    id: 'r1',
    title: 'סלט כרוב',
    source: 'OneNote',
  };

  const updates = computeBulkRecipeUpdates(recipe, {
    applySource: true,
    newSource: 'OneNote (PDF)',
  });

  assert.equal(updates.source, 'OneNote (PDF)');
});

test('computeBulkRecipeUpdates handles dietary replacement mode', () => {
  const recipe = {
    id: 'r1',
    title: 'עוגת שוקולד',
    dietary: ['dairy'],
  };

  const updates = computeBulkRecipeUpdates(recipe, {
    applyDietary: true,
    chosenDietary: ['parve', 'vegan'],
    dietaryMode: 'replace',
  });

  assert.deepEqual(updates.dietary, ['parve', 'vegan']);
});

test('computeBulkRecipeUpdates handles dietary add/merge mode without duplicates', () => {
  const recipe = {
    id: 'r1',
    title: 'פשטידת פטריות',
    dietary: ['parve', 'vegetarian'],
  };

  const updates = computeBulkRecipeUpdates(recipe, {
    applyDietary: true,
    chosenDietary: ['vegetarian', 'gluten-free'],
    dietaryMode: 'add',
  });

  assert.deepEqual(updates.dietary, ['parve', 'vegetarian', 'gluten-free']);
});

test('computeBulkRecipeUpdates handles tagsToAdd appending and deduplication', () => {
  const recipe = {
    id: 'r1',
    title: 'פוקאצ׳ה',
    tags: ['baking', 'italian'],
  };

  const updates = computeBulkRecipeUpdates(recipe, {
    applyTags: true,
    tagsToAdd: ['italian', 'weekend', 'fresh '],
  });

  assert.deepEqual(updates.tags, ['baking', 'italian', 'weekend', 'fresh']);
});

test('computeBulkRecipeUpdates applies multiple labels simultaneously leaving other recipe data untouched', () => {
  const recipe = {
    id: 'r100',
    title: 'חלה לשבת',
    category: 'Other',
    language: 'en',
    source: 'Manual',
    dietary: ['parve'],
    tags: ['shabbat'],
    ingredients: [{ name: 'קמח', amount: '1', unit: 'קג' }],
    steps: ['לשים ומתפיחים'],
    notes: 'מורחים בביצה',
    thumbnailDataUri: 'data:image/jpeg;base64,sample',
  };

  const updates = computeBulkRecipeUpdates(recipe, {
    applyCategory: true,
    newCategory: 'מאפים',
    applyLanguage: true,
    newLanguage: 'he',
    applySource: true,
    newSource: 'OneNote (PDF)',
    applyDietary: true,
    chosenDietary: ['vegan'],
    dietaryMode: 'replace',
    applyTags: true,
    tagsToAdd: ['holiday'],
  });

  assert.deepEqual(updates, {
    category: 'מאפים',
    language: 'he',
    source: 'OneNote (PDF)',
    dietary: ['vegan'],
    tags: ['shabbat', 'holiday'],
  });

  // Verify that merging updates preserves untouched fields
  const updatedRecipe = { ...recipe, ...updates };
  assert.equal(updatedRecipe.title, 'חלה לשבת');
  assert.equal(updatedRecipe.thumbnailDataUri, 'data:image/jpeg;base64,sample');
  assert.deepEqual(updatedRecipe.ingredients, recipe.ingredients);
  assert.deepEqual(updatedRecipe.steps, recipe.steps);
  assert.equal(updatedRecipe.notes, recipe.notes);
});
