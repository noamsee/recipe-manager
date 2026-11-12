import test from 'node:test';
import assert from 'node:assert/strict';
import { recipesToJson, recipesToMarkdown } from '../js/export.js';

test('recipesToJson and recipesToMarkdown preserve Hebrew/English recipe structure', () => {
  const recipes = [
    {
      title: 'שקשוקה',
      language: 'he',
      category: 'Breakfast',
      servings: 2,
      dietary: ['parve', 'vegetarian'],
      tags: ['quick'],
      sourceUrl: 'https://www.instagram.com/reel/ABC/',
      ingredients: [{ name: 'עגבניות', amount: '4', unit: '' }],
      steps: ['מטגנים שום ומוסיפים עגבניות'],
      notes: 'טעים עם חלה',
    },
  ];

  const json = JSON.parse(recipesToJson(recipes));
  assert.equal(json.count, 1);
  assert.equal(json.recipes[0].title, 'שקשוקה');

  const md = recipesToMarkdown(recipes);
  assert.match(md, /# שקשוקה/);
  assert.match(md, /- 4 עגבניות/);
  assert.match(md, /1\. מטגנים שום ומוסיפים עגבניות/);
  assert.match(md, /Source: https:\/\/www\.instagram\.com\/reel\/ABC\//);
});
