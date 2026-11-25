/**
 * Bulk label editing helper functions.
 * Pure logic with zero dependencies, 100% testable in Node and browser.
 */

/**
 * Compute the partial updates object to apply to a recipe based on chosen bulk edit fields.
 *
 * @param {Object} recipe
 * @param {Object} options
 * @param {boolean} [options.applyCategory]
 * @param {string} [options.newCategory]
 * @param {boolean} [options.applyLanguage]
 * @param {string} [options.newLanguage]
 * @param {boolean} [options.applySource]
 * @param {string} [options.newSource]
 * @param {boolean} [options.applyDietary]
 * @param {string[]} [options.chosenDietary]
 * @param {'replace'|'add'} [options.dietaryMode]
 * @param {boolean} [options.applyTags]
 * @param {string[]} [options.tagsToAdd]
 * @returns {Object} updates
 */
export function computeBulkRecipeUpdates(recipe = {}, options = {}) {
  const {
    applyCategory = false,
    newCategory = null,
    applyLanguage = false,
    newLanguage = null,
    applySource = false,
    newSource = null,
    applyDietary = false,
    chosenDietary = null,
    dietaryMode = 'replace',
    applyTags = false,
    tagsToAdd = null,
  } = options;

  const updates = {};

  if (applyCategory && typeof newCategory === 'string' && newCategory.trim()) {
    updates.category = newCategory.trim();
  }

  if (applyLanguage && typeof newLanguage === 'string' && newLanguage.trim()) {
    updates.language = newLanguage.trim();
  }

  if (applySource && typeof newSource === 'string' && newSource.trim()) {
    updates.source = newSource.trim();
  }

  if (applyDietary && Array.isArray(chosenDietary)) {
    if (dietaryMode === 'replace') {
      updates.dietary = [...chosenDietary];
    } else {
      const existing = Array.isArray(recipe.dietary) ? recipe.dietary : [];
      updates.dietary = Array.from(new Set([...existing, ...chosenDietary]));
    }
  }

  if (applyTags && Array.isArray(tagsToAdd) && tagsToAdd.length > 0) {
    const existing = Array.isArray(recipe.tags) ? recipe.tags : [];
    const cleanedToAdd = tagsToAdd.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
    updates.tags = Array.from(new Set([...existing, ...cleanedToAdd]));
  }

  return updates;
}
