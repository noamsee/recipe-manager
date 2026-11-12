import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTextDirection } from '../js/rtl.js';

test('detectTextDirection detects Hebrew text as rtl', () => {
  assert.equal(detectTextDirection('עוגת שוקולד קלה'), 'rtl');
  assert.equal(detectTextDirection('250 גרם קמח (all purpose)'), 'rtl');
});

test('detectTextDirection detects English text as ltr', () => {
  assert.equal(detectTextDirection('Classic Chocolate Cake'), 'ltr');
  assert.equal(detectTextDirection('2 cups flour'), 'ltr');
});

test('detectTextDirection respects explicit Hebrew language', () => {
  assert.equal(detectTextDirection('', 'he'), 'rtl');
});
