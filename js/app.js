/**
 * Main SPA controller for Recipe Manager.
 */

import { logApi, subscribeApiLogs, translateRecipe } from './api.js?v=5';
import {
  DEFAULT_API_URL,
  DEFAULT_FIREBASE_CONFIG,
  getAppConfig,
  isFirebaseConfigured,
  saveAppConfig,
} from './config.js?v=5';
import { isWakeLockActive, setWakeLockEnabled } from './cook-mode.js?v=5';
import {
  downloadTextFile,
  exportRecipesToPdf,
  filterRecipesForExport,
  recipesToJson,
  recipesToMarkdown,
} from './export.js?v=6';
import {
  logoutUser,
  registerWithEmail,
  signInWithEmail,
  signInWithGoogle,
  subscribeAuth,
} from './firebase-client.js?v=5';
import {
  buildBatchQueue,
  clearAllUnparsableItems,
  deleteImportLog,
  deleteQueueItem,
  enqueueBatchItems,
  eraseQueueItemOnSuccess,
  extractRecipesFromOneNoteFile,
  formatCountdown,
  isItemReadyForRetry,
  loadUserImportLogs,
  loadUserImportQueue,
  MAX_RETRY_ATTEMPTS,
  normalizeReelUrl,
  parseWhatsAppExport,
  processBatchQueue,
  recordQueueItemFailure,
  resetQueueItemForRetry,
  runCaptionFallbackExtraction,
  runSingleReelExtraction,
  saveImportSessionLog,
} from './importer.js?v=5';
import { extractRecipesFromZip, validateZipArchive } from './zip-importer.js?v=1';
import {
  classifyQueueItems,
  computeNextStatusAndRetry,
  createAttemptRecord,
} from './import-queue-logic.js?v=5';
import {
  compressImageToDataUri,
  createOrUpdateShareLink,
  deleteRecipeById,
  filterRecipes,
  loadUserRecipes,
  migrateExistingRecipesSource,
  saveRecipe,
} from './recipes.js?v=6';
import { applyDirection } from './rtl.js?v=5';
import {
  addShoppingItems,
  addSingleShoppingItem,
  clearCheckedShoppingItems,
  loadShoppingList,
  removeShoppingItem,
  toggleShoppingItem,
} from './shopping-list.js?v=5';

const state = {
  user: null,
  recipes: [],
  shoppingItems: [],
  activeView: 'library',
  selectedRecipeId: null,
  editingRecipeId: null,
  pendingThumbnailDataUri: '',
  pendingOneNoteRecipes: [],
  pendingOneNoteUnparsed: [],
  pendingOneNoteFailed: [],
  pendingZipRecipes: [],
  filters: { search: '', category: 'ALL', language: 'ALL', dietary: 'ALL', source: 'ALL' },
  importQueue: [],
  importLogs: [],
  isBatchRunning: false,
};

const $ = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast ${isError ? 'toast-error' : 'toast-ok'}`;
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function switchTopLevelScreen(screenId) {
  for (const id of ['auth-screen', 'app-shell']) {
    const el = $(id);
    if (el) el.hidden = id !== screenId;
  }
}

function switchView(viewName) {
  state.activeView = viewName;
  for (const name of ['library', 'detail', 'editor', 'shopping', 'import', 'settings']) {
    $(`view-${name}`).hidden = name !== viewName;
  }
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === viewName);
  });
  if (viewName !== 'detail' && isWakeLockActive()) {
    setWakeLockEnabled(false, updateWakeLockButton);
  }
  if (viewName === 'import' && state.user) {
    refreshImportQueue().catch(console.warn);
    refreshImportLogs().catch(console.warn);
  }
  if (viewName === 'settings') {
    updateExportFilterOptions();
  }
}

function updateWakeLockButton(isOn, msg = '') {
  const btn = $('wake-lock-btn');
  if (!btn) return;
  btn.dataset.active = String(isOn);
  btn.textContent = isOn ? 'Cook Mode: Screen Awake ON' : 'Cook Mode: Keep Screen Awake';
  if (msg) $('wake-lock-status').textContent = msg;
}

async function refreshLibrary() {
  if (!state.user) return;
  // Automatically migrate any legacy recipes without source to source: 'Reel'
  migrateExistingRecipesSource(state.user.uid).catch(console.warn);
  state.recipes = await loadUserRecipes(state.user.uid);
  populateCategoryFilter();
  updateExportFilterOptions();
  renderRecipeGrid();
}

async function refreshShoppingList() {
  if (!state.user) return;
  state.shoppingItems = await loadShoppingList(state.user.uid);
  renderShoppingList();
}

function populateCategoryFilter() {
  const select = $('filter-category');
  const current = state.filters.category;
  const categories = Array.from(new Set(state.recipes.map((r) => r.category || 'Other'))).sort();
  select.innerHTML = '<option value="ALL">All Categories</option>';
  for (const cat of categories) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  }
  select.value = categories.includes(current) ? current : 'ALL';
}

function renderRecipeGrid() {
  const grid = $('recipe-grid');
  const visible = filterRecipes(state.recipes, state.filters);
  $('recipe-count').textContent = `${visible.length} of ${state.recipes.length} recipes`;

  if (!visible.length) {
    grid.innerHTML =
      '<div class="empty-state">No matching recipes yet. Add a Reel link, import from WhatsApp/OneNote, or create one manually.</div>';
    return;
  }

  grid.innerHTML = '';
  for (const recipe of visible) {
    const card = document.createElement('article');
    card.className = 'recipe-card';
    applyDirection(card, recipe.title, recipe.language);

    const thumbHtml = recipe.thumbnailDataUri
      ? `<img class="card-thumb" src="${escapeHtml(recipe.thumbnailDataUri)}" alt="${escapeHtml(recipe.title)}" loading="lazy" />`
      : `<div class="card-thumb card-thumb-placeholder">${recipe.language === 'he' ? 'מתכון' : 'Recipe'}</div>`;

    const source = recipe.source || (recipe.sourceUrl ? 'Reel' : (recipe.tags?.includes('OneNote') ? 'OneNote' : 'Manual'));
    const stars = recipe.rating ? '★'.repeat(recipe.rating) + '☆'.repeat(5 - recipe.rating) : '';
    const chips = [
      `<span class="chip chip-source chip-source-${source.toLowerCase()}">${escapeHtml(source)}</span>`,
      recipe.category ? `<span class="chip">${escapeHtml(recipe.category)}</span>` : '',
      `<span class="chip">${recipe.language === 'he' ? 'עברית' : 'EN'}</span>`,
      ...(recipe.dietary || []).slice(0, 2).map((c) => `<span class="chip">${escapeHtml(c)}</span>`),
    ]
      .filter(Boolean)
      .join('');

    card.innerHTML = `
      ${thumbHtml}
      <div class="card-body">
        <h3>${escapeHtml(recipe.title)}</h3>
        <div class="chip-row">${chips}</div>
        <div class="card-meta">
          <span>${(recipe.ingredients || []).length} ingredients</span>
          ${stars ? `<span class="stars">${stars}</span>` : ''}
        </div>
      </div>
    `;
    card.addEventListener('click', () => openRecipeDetail(recipe.id));
    grid.appendChild(card);
  }
}

function openRecipeDetail(recipeId) {
  const recipe = state.recipes.find((r) => r.id === recipeId);
  if (!recipe) return;
  state.selectedRecipeId = recipeId;
  switchView('detail');

  const container = $('detail-content');
  container.innerHTML = '';
  applyDirection(container, recipe.title, recipe.language);

  if (recipe.thumbnailDataUri) {
    const img = document.createElement('img');
    img.className = 'detail-hero-img';
    img.src = recipe.thumbnailDataUri;
    img.alt = recipe.title;
    container.appendChild(img);
  }

  const titleEl = document.createElement('h2');
  titleEl.textContent = recipe.title;
  container.appendChild(titleEl);

  const metaRow = document.createElement('div');
  metaRow.className = 'chip-row';
  const source = recipe.source || (recipe.sourceUrl ? 'Reel' : (recipe.tags?.includes('OneNote') ? 'OneNote' : 'Manual'));
  const metaChips = [
    `Source: ${source}`,
    recipe.category,
    recipe.language === 'he' ? 'עברית (RTL)' : 'English (LTR)',
    recipe.servings ? `${recipe.servings} servings` : '',
    recipe.prepTimeMinutes ? `Prep ${recipe.prepTimeMinutes}m` : '',
    recipe.cookTimeMinutes ? `Cook ${recipe.cookTimeMinutes}m` : '',
    ...(recipe.dietary || []),
    ...(recipe.tags || []),
  ].filter(Boolean);
  for (const label of metaChips) {
    const span = document.createElement('span');
    span.className = label.startsWith('Source:') ? `chip chip-source chip-source-${source.toLowerCase()}` : 'chip';
    span.textContent = label;
    metaRow.appendChild(span);
  }
  container.appendChild(metaRow);

  // Rating widget
  const ratingBar = document.createElement('div');
  ratingBar.className = 'rating-bar';
  ratingBar.innerHTML = '<span>Rating:</span>';
  for (let star = 1; star <= 5; star += 1) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `star-btn ${star <= (recipe.rating || 0) ? 'filled' : ''}`;
    btn.textContent = star <= (recipe.rating || 0) ? '★' : '☆';
    btn.title = `Rate ${star} stars`;
    btn.addEventListener('click', async () => {
      await saveRecipe(state.user.uid, { ...recipe, rating: star }, recipe.id);
      await refreshLibrary();
      openRecipeDetail(recipe.id);
    });
    ratingBar.appendChild(btn);
  }
  container.appendChild(ratingBar);

  if (recipe.sourceUrl) {
    const srcLink = document.createElement('a');
    srcLink.href = recipe.sourceUrl;
    srcLink.target = '_blank';
    srcLink.rel = 'noopener noreferrer';
    srcLink.className = 'source-link';
    srcLink.textContent = `Original Source: ${recipe.sourceUrl}`;
    container.appendChild(srcLink);
  }

  const translateBtn = $('detail-translate-btn');
  const nextLang = recipe.language === 'he' ? 'en' : 'he';
  translateBtn.textContent = nextLang === 'he' ? 'Translate to Hebrew (עברית)' : 'Translate to English';

  // Ingredients checklist
  const ingTitle = document.createElement('h3');
  ingTitle.textContent = recipe.language === 'he' ? 'מצרכים' : 'Ingredients';
  container.appendChild(ingTitle);

  const ingList = document.createElement('ul');
  ingList.className = 'checklist';
  for (const ing of recipe.ingredients || []) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const text = [ing.amount, ing.unit, ing.name].filter(Boolean).join(' ');
    const span = document.createElement('span');
    span.textContent = ing.group ? `[${ing.group}] ${text}` : text;
    applyDirection(li, text, recipe.language);
    label.append(cb, span);
    li.appendChild(label);
    ingList.appendChild(li);
  }
  container.appendChild(ingList);

  // Steps checklist
  const stepTitle = document.createElement('h3');
  stepTitle.textContent = recipe.language === 'he' ? 'אופן הכנה' : 'Instructions';
  container.appendChild(stepTitle);

  const stepList = document.createElement('ol');
  stepList.className = 'checklist steps-list';
  for (const step of recipe.steps || []) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const span = document.createElement('span');
    span.textContent = step;
    applyDirection(li, step, recipe.language);
    label.append(cb, span);
    li.appendChild(label);
    stepList.appendChild(li);
  }
  container.appendChild(stepList);

  if (recipe.notes) {
    const notesTitle = document.createElement('h3');
    notesTitle.textContent = 'Personal Notes';
    const notesEl = document.createElement('p');
    notesEl.className = 'recipe-notes';
    notesEl.textContent = recipe.notes;
    applyDirection(notesEl, recipe.notes, recipe.language);
    container.append(notesTitle, notesEl);
  }
}

function openRecipeEditor(recipe = null) {
  state.editingRecipeId = recipe?.id || null;
  state.pendingThumbnailDataUri = recipe?.thumbnailDataUri || '';
  switchView('editor');

  $('editor-heading').textContent = recipe ? 'Edit Recipe' : 'New Recipe';
  $('edit-title').value = recipe?.title || '';
  $('edit-language').value = recipe?.language || 'en';
  $('edit-category').value = recipe?.category || 'Main';
  if ($('edit-source')) {
    $('edit-source').value = recipe?.source || 'Manual';
  }
  $('edit-servings').value = recipe?.servings ?? '';
  $('edit-prep').value = recipe?.prepTimeMinutes ?? '';
  $('edit-cook').value = recipe?.cookTimeMinutes ?? '';
  $('edit-source-url').value = recipe?.sourceUrl || '';
  $('edit-tags').value = (recipe?.tags || []).join(', ');
  $('edit-notes').value = recipe?.notes || '';

  const dietarySet = new Set(recipe?.dietary || []);
  document.querySelectorAll('input[name="edit-dietary"]').forEach((cb) => {
    cb.checked = dietarySet.has(cb.value);
  });

  $('edit-ingredients').value = (recipe?.ingredients || [])
    .map((i) => [i.amount, i.unit, i.name].filter(Boolean).join(' '))
    .join('\n');
  $('edit-steps').value = (recipe?.steps || []).join('\n');

  const preview = $('edit-thumb-preview');
  if (state.pendingThumbnailDataUri) {
    preview.src = state.pendingThumbnailDataUri;
    preview.hidden = false;
  } else {
    preview.hidden = true;
  }
}

function parseIngredientLine(line) {
  const trimmed = line.trim();
  const match = trimmed.match(/^([\d./¼½¾⅓⅔-]+(?:\s*-\s*[\d./]+)?)\s+(\S+)\s+(.+)$/);
  if (match) {
    return { amount: match[1], unit: match[2], name: match[3], group: '' };
  }
  const numOnly = trimmed.match(/^([\d./¼½¾⅓⅔-]+)\s+(.+)$/);
  if (numOnly) {
    return { amount: numOnly[1], unit: '', name: numOnly[2], group: '' };
  }
  return { amount: '', unit: '', name: trimmed, group: '' };
}

function renderShoppingList() {
  const ul = $('shopping-items');
  ul.innerHTML = '';
  if (!state.shoppingItems.length) {
    ul.innerHTML = '<li class="empty-state">Your supermarket shopping list is empty.</li>';
    return;
  }

  for (const item of state.shoppingItems) {
    const li = document.createElement('li');
    li.className = `shopping-item ${item.checked ? 'is-checked' : ''}`;
    applyDirection(li, item.text);

    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(item.checked);
    cb.addEventListener('change', async () => {
      await toggleShoppingItem(item.id, cb.checked);
      await refreshShoppingList();
    });

    const textWrap = document.createElement('span');
    textWrap.textContent = item.recipeTitle ? `${item.text} (${item.recipeTitle})` : item.text;
    label.append(cb, textWrap);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-ghost btn-sm';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      await removeShoppingItem(item.id);
      await refreshShoppingList();
    });

    li.append(label, delBtn);
    ul.appendChild(li);
  }
}

function renderOneNotePreview() {
  const container = $('onenote-preview-list');
  const previewCard = $('onenote-preview-card');
  const countEl = $('onenote-preview-count');
  const saveBtn = $('onenote-save-btn');
  const unparsedCard = $('onenote-unparsed-card');
  const unparsedList = $('onenote-unparsed-list');
  const failedCard = $('onenote-failed-card');
  const failedList = $('onenote-failed-list');

  // 1. Parsed candidate recipes
  if (container) container.innerHTML = '';
  const recipes = state.pendingOneNoteRecipes || [];
  if (previewCard) previewCard.hidden = recipes.length === 0;
  if (saveBtn) saveBtn.hidden = recipes.length === 0;
  if (countEl) countEl.textContent = `Parsed Recipes (${recipes.length})`;

  if (container && recipes.length > 0) {
    recipes.forEach((recipe, idx) => {
      const card = document.createElement('div');
      card.className = 'onenote-pick-card';
      applyDirection(card, recipe.title, recipe.language);

      const dietaryChips = (recipe.dietary || [])
        .map((d) => `<span class="chip chip-dietary">${escapeHtml(d)}</span>`)
        .join(' ');

      card.innerHTML = `
        <input type="checkbox" class="onenote-pick" data-idx="${idx}" checked />
        <div class="stack" style="gap: 0.25rem; flex: 1;">
          <div class="row between">
            <strong>${escapeHtml(recipe.title)}</strong>
            <div class="row">
              <span class="chip">${escapeHtml(recipe.language || 'en')}</span>
              <span class="chip">${escapeHtml(recipe.category || 'Other')}</span>
            </div>
          </div>
          <div class="muted small">
            ${(recipe.ingredients || []).length} ingredients &bull; ${(recipe.steps || []).length} steps
            ${dietaryChips ? `&bull; ${dietaryChips}` : ''}
          </div>
        </div>
      `;
      container.appendChild(card);
    });
    updateOneNoteSaveBtnText();
  }

  // 2. Unparsed / Incomplete sections
  const unparsed = state.pendingOneNoteUnparsed || [];
  if (unparsedCard) unparsedCard.hidden = unparsed.length === 0;
  if (unparsedList) {
    unparsedList.innerHTML = '';
    unparsed.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'queue-item-card';
      card.style.borderColor = '#f59e0b';
      card.style.background = '#fffbeb';

      card.innerHTML = `
        <div class="queue-item-header">
          <strong>${escapeHtml(item.title || 'Untitled note')}</strong>
          <span class="chip chip-cooldown">${escapeHtml(item.reason || 'Incomplete')}</span>
        </div>
        ${item.rawText ? `<div class="queue-error-preview" style="color: #92400e; background: rgba(245,158,11,0.1);">${escapeHtml(item.rawText.slice(0, 250))}...</div>` : ''}
        <div class="queue-actions">
          <button type="button" class="btn-primary btn-sm" data-action="manual-review" data-idx="${idx}">Review &amp; Add Manually</button>
          <button type="button" class="btn-ghost btn-sm" data-action="dismiss-unparsed" data-idx="${idx}">Dismiss</button>
        </div>
      `;

      card.querySelector('[data-action="manual-review"]')?.addEventListener('click', () => {
        openManualEditorWithCandidate(item);
        state.pendingOneNoteUnparsed.splice(idx, 1);
        renderOneNotePreview();
      });

      card.querySelector('[data-action="dismiss-unparsed"]')?.addEventListener('click', () => {
        state.pendingOneNoteUnparsed.splice(idx, 1);
        renderOneNotePreview();
      });

      unparsedList.appendChild(card);
    });
  }

  // 3. Failed to save items
  const failed = state.pendingOneNoteFailed || [];
  if (failedCard) failedCard.hidden = failed.length === 0;
  if (failedList) {
    failedList.innerHTML = '';
    failed.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'queue-item-card unparsable';
      card.innerHTML = `
        <div class="queue-item-header">
          <strong>${escapeHtml(item.title || 'Untitled recipe')}</strong>
          <span class="chip chip-unparsable">Save Failed</span>
        </div>
        <div class="queue-error-preview">${escapeHtml(item.error || 'Failed saving to library')}</div>
        <div class="queue-actions">
          <button type="button" class="btn-primary btn-sm" data-action="manual-review-failed" data-idx="${idx}">Review &amp; Add Manually</button>
          <button type="button" class="btn-ghost btn-sm" data-action="dismiss-failed" data-idx="${idx}">Dismiss</button>
        </div>
      `;

      card.querySelector('[data-action="manual-review-failed"]')?.addEventListener('click', () => {
        openManualEditorWithCandidate(item.recipe || item);
        state.pendingOneNoteFailed.splice(idx, 1);
        renderOneNotePreview();
      });

      card.querySelector('[data-action="dismiss-failed"]')?.addEventListener('click', () => {
        state.pendingOneNoteFailed.splice(idx, 1);
        renderOneNotePreview();
      });

      failedList.appendChild(card);
    });
  }
}

function updateOneNoteSaveBtnText() {
  const checked = document.querySelectorAll('.onenote-pick:checked').length;
  const btn = $('onenote-save-btn');
  if (btn) btn.textContent = `Import Selected Recipes (${checked})`;
}

function updateZipSaveBtnText() {
  const checked = document.querySelectorAll('.zip-pick:checked').length;
  const btn = $('zip-save-btn');
  if (btn) {
    btn.textContent = `Import Selected Recipes (${checked})`;
    btn.disabled = checked === 0;
  }
}

function renderZipPreview() {
  const container = $('zip-preview-list');
  const previewCard = $('zip-preview-card');
  const countEl = $('zip-preview-count');
  const saveBtn = $('zip-save-btn');

  if (container) container.innerHTML = '';
  const recipes = state.pendingZipRecipes || [];
  if (previewCard) previewCard.hidden = recipes.length === 0;
  if (saveBtn) saveBtn.hidden = recipes.length === 0;
  if (countEl) countEl.textContent = `Archive Recipes (${recipes.length})`;

  if (container && recipes.length > 0) {
    recipes.forEach((recipe, idx) => {
      const card = document.createElement('div');
      card.className = 'zip-pick-card';
      applyDirection(card, recipe.title, recipe.language);

      const thumbHtml = recipe.thumbnailDataUri
        ? `<img src="${escapeHtml(recipe.thumbnailDataUri)}" class="zip-card-thumb" alt="Thumbnail" />`
        : `<div class="zip-card-thumb-placeholder">${recipe.language === 'he' ? '🍲' : '🍽️'}</div>`;

      const dietaryChips = (recipe.dietary || [])
        .map((d) => `<span class="chip chip-dietary">${escapeHtml(d)}</span>`)
        .join(' ');

      card.innerHTML = `
        <input type="checkbox" class="zip-pick" data-idx="${idx}" checked />
        ${thumbHtml}
        <div class="stack" style="gap: 0.25rem; flex: 1;">
          <div class="row between">
            <strong>${escapeHtml(recipe.title)}</strong>
            <div class="row">
              <span class="chip">${escapeHtml(recipe.language || 'he')}</span>
              <span class="chip">${escapeHtml(recipe.category || 'Other')}</span>
              ${recipe.servings ? `<span class="chip">${recipe.servings} מנות</span>` : ''}
            </div>
          </div>
          <div class="muted small">
            ${(recipe.ingredients || []).length} ingredients &bull; ${(recipe.steps || []).length} steps
            ${recipe.hasThumbnail ? '&bull; 📷 Photo' : ''}
            ${dietaryChips ? `&bull; ${dietaryChips}` : ''}
          </div>
        </div>
      `;
      container.appendChild(card);
    });
    updateZipSaveBtnText();
  }
}

function openManualEditorWithCandidate(candidate) {
  state.editingRecipeId = null;
  state.selectedRecipeId = null;
  state.pendingThumbnailDataUri = '';

  $('editor-heading').textContent = 'Review & Add Recipe Manually';
  $('edit-title').value = candidate.title || '';
  $('edit-language').value = candidate.language === 'he' ? 'he' : 'en';
  $('edit-category').value = candidate.category || 'Main';
  $('edit-servings').value = candidate.servings || '';
  $('edit-prep').value = candidate.prepTimeMinutes || '';
  $('edit-cook').value = candidate.cookTimeMinutes || '';
  $('edit-source-url').value = candidate.sourceUrl || '';
  $('edit-tags').value = Array.isArray(candidate.tags) ? candidate.tags.join(', ') : '';

  // Dietary
  document.querySelectorAll('input[name="edit-dietary"]').forEach((cb) => {
    cb.checked = Array.isArray(candidate.dietary) && candidate.dietary.includes(cb.value);
  });

  // Ingredients & steps
  const ingText = (candidate.ingredients || [])
    .map((i) => {
      if (typeof i === 'string') return i;
      const qty = [i.amount, i.unit].filter(Boolean).join(' ');
      return `${qty ? `${qty} ` : ''}${i.name || ''}`.trim();
    })
    .filter(Boolean)
    .join('\n');
  $('edit-ingredients').value = ingText;

  const stepText = Array.isArray(candidate.steps)
    ? candidate.steps.join('\n')
    : '';
  $('edit-steps').value = stepText;

  $('edit-notes').value = candidate.notes || candidate.rawText || candidate.reason || '';

  if ($('edit-source')) {
    $('edit-source').value = 'OneNote';
  }

  $('edit-thumb-preview').hidden = true;
  $('edit-thumb-file').value = '';

  switchView('editor');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  showToast('Recipe pre-filled in editor. Review ingredients and click Save Recipe.');
}

function getExportFilters() {
  return {
    category: $('export-filter-category')?.value || 'ALL',
    dietary: $('export-filter-dietary')?.value || 'ALL',
    tag: $('export-filter-tag')?.value || 'ALL',
    language: $('export-filter-language')?.value || 'ALL',
  };
}

function updateExportFilterOptions() {
  const catSelect = $('export-filter-category');
  const tagSelect = $('export-filter-tag');
  if (!catSelect || !tagSelect) return;

  const currentCat = catSelect.value;
  const currentTag = tagSelect.value;

  const categories = new Set();
  const tags = new Set();
  (state.recipes || []).forEach((r) => {
    if (r.category && r.category.trim()) categories.add(r.category.trim());
    if (Array.isArray(r.tags)) {
      r.tags.forEach((t) => {
        if (t && t.trim()) tags.add(t.trim());
      });
    }
  });

  catSelect.innerHTML = '<option value="ALL">All Categories</option>';
  Array.from(categories).sort().forEach((cat) => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    catSelect.appendChild(opt);
  });
  catSelect.value = categories.has(currentCat) ? currentCat : 'ALL';

  tagSelect.innerHTML = '<option value="ALL">All Tags</option>';
  Array.from(tags).sort().forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = `#${t}`;
    tagSelect.appendChild(opt);
  });
  tagSelect.value = tags.has(currentTag) ? currentTag : 'ALL';

  updateExportMatchCount();
}

function updateExportMatchCount() {
  const matches = filterRecipesForExport(state.recipes, getExportFilters());
  const countEl = $('export-match-count');
  if (countEl) {
    countEl.textContent = `Matching recipes to export: ${matches.length} (out of ${state.recipes.length} total in library)`;
  }
}

function bindEvents() {
  // Auth handlers
  $('google-login-btn').addEventListener('click', async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('email-auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    try {
      await signInWithEmail(email, password);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('register-btn').addEventListener('click', async () => {
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    try {
      await registerWithEmail(email, password);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('logout-btn').addEventListener('click', () => logoutUser());

  // Navigation buttons
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.nav;
      if (target === 'editor') {
        openRecipeEditor(null);
      } else if (target === 'shopping') {
        switchView('shopping');
        await refreshShoppingList();
      } else {
        switchView(target);
      }
    });
  });

  // Filters
  $('search-input').addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    renderRecipeGrid();
  });
  $('filter-category').addEventListener('change', (e) => {
    state.filters.category = e.target.value;
    renderRecipeGrid();
  });
  $('filter-language').addEventListener('change', (e) => {
    state.filters.language = e.target.value;
    renderRecipeGrid();
  });
  $('filter-dietary').addEventListener('change', (e) => {
    state.filters.dietary = e.target.value;
    renderRecipeGrid();
  });
  $('filter-source')?.addEventListener('change', (e) => {
    state.filters.source = e.target.value;
    renderRecipeGrid();
  });

  // Detail actions
  $('detail-back-btn').addEventListener('click', () => switchView('library'));
  $('wake-lock-btn').addEventListener('click', () => {
    setWakeLockEnabled(!isWakeLockActive(), updateWakeLockButton);
  });

  $('detail-edit-btn').addEventListener('click', () => {
    const recipe = state.recipes.find((r) => r.id === state.selectedRecipeId);
    if (recipe) openRecipeEditor(recipe);
  });

  $('detail-delete-btn').addEventListener('click', async () => {
    if (!state.selectedRecipeId || !confirm('Delete this recipe permanently?')) return;
    await deleteRecipeById(state.selectedRecipeId);
    showToast('Recipe deleted.');
    await refreshLibrary();
    switchView('library');
  });

  $('detail-shopping-btn').addEventListener('click', async () => {
    const recipe = state.recipes.find((r) => r.id === state.selectedRecipeId);
    if (!recipe) return;
    await addShoppingItems(state.user.uid, recipe.ingredients || [], recipe.title);
    showToast('Ingredients added to Supermarket Shopping List.');
  });

  $('detail-share-btn').addEventListener('click', async () => {
    const recipe = state.recipes.find((r) => r.id === state.selectedRecipeId);
    if (!recipe) return;
    const shareId = await createOrUpdateShareLink(state.user.uid, recipe);
    const shareUrl = new URL(`share.html?id=${shareId}`, window.location.href).toString();
    await navigator.clipboard?.writeText(shareUrl).catch(() => {});
    $('share-url-output').hidden = false;
    $('share-url-input').value = shareUrl;
    showToast('Read-only share link created and copied!');
    await refreshLibrary();
  });

  $('detail-translate-btn').addEventListener('click', async () => {
    const recipe = state.recipes.find((r) => r.id === state.selectedRecipeId);
    if (!recipe) return;
    const targetLanguage = recipe.language === 'he' ? 'en' : 'he';
    const btn = $('detail-translate-btn');
    btn.disabled = true;
    btn.textContent = 'Translating...';
    try {
      const translated = await translateRecipe(recipe, targetLanguage);
      await saveRecipe(
        state.user.uid,
        {
          ...recipe,
          ...translated,
          notes: recipe.notes,
          rating: recipe.rating,
          thumbnailDataUri: recipe.thumbnailDataUri,
        },
        recipe.id
      );
      await refreshLibrary();
      openRecipeDetail(recipe.id);
      showToast(`Translated to ${targetLanguage === 'he' ? 'Hebrew' : 'English'}.`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('detail-pdf-btn')?.addEventListener('click', () => {
    const recipe = state.recipes.find((r) => r.id === state.selectedRecipeId);
    if (!recipe) return showToast('Recipe not found', true);
    exportRecipesToPdf([recipe], { title: recipe.title });
  });

  // Editor form
  $('edit-thumb-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    state.pendingThumbnailDataUri = await compressImageToDataUri(file);
    $('edit-thumb-preview').src = state.pendingThumbnailDataUri;
    $('edit-thumb-preview').hidden = false;
  });

  $('editor-cancel-btn').addEventListener('click', () => {
    switchView(state.editingRecipeId ? 'detail' : 'library');
  });

  $('editor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dietary = Array.from(document.querySelectorAll('input[name="edit-dietary"]:checked')).map(
      (cb) => cb.value
    );
    const ingredients = $('edit-ingredients')
      .value.split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(parseIngredientLine);
    const steps = $('edit-steps')
      .value.split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const tags = $('edit-tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const existing = state.editingRecipeId
      ? state.recipes.find((r) => r.id === state.editingRecipeId)
      : null;

    const sourceVal = $('edit-source')?.value || (existing?.source || 'Manual');

    const id = await saveRecipe(
      state.user.uid,
      {
        title: $('edit-title').value,
        source: sourceVal,
        language: $('edit-language').value,
        category: $('edit-category').value.trim() || 'Other',
        servings: $('edit-servings').value ? Number($('edit-servings').value) : null,
        prepTimeMinutes: $('edit-prep').value ? Number($('edit-prep').value) : null,
        cookTimeMinutes: $('edit-cook').value ? Number($('edit-cook').value) : null,
        sourceUrl: $('edit-source-url').value.trim() || null,
        tags,
        dietary,
        ingredients,
        steps,
        notes: $('edit-notes').value.trim(),
        rating: existing?.rating || 0,
        thumbnailDataUri: state.pendingThumbnailDataUri,
      },
      state.editingRecipeId
    );
    showToast('Recipe saved!');
    await refreshLibrary();
    openRecipeDetail(id);
  });

  // Import tabs
  document.querySelectorAll('[data-import-tab]').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset.importTab;
      document.querySelectorAll('[data-import-tab]').forEach((b) =>
        b.classList.toggle('active', b === tabBtn)
      );
      for (const pane of ['single-reel', 'batch-whatsapp', 'onenote', 'zip', 'paste-text']) {
        $(`pane-${pane}`).hidden = pane !== target;
      }
      if (target === 'batch-whatsapp') {
        refreshImportQueue().catch(console.warn);
        refreshImportLogs().catch(console.warn);
      }
    });
  });

  // Single Reel extraction + fallback + live diagnostics
  const debugBox = $('reel-debug-box');
  const debugOutput = $('reel-debug-output');
  const toggleDebugBtn = $('toggle-debug-btn');
  const copyDebugBtn = $('copy-debug-btn');

  if (toggleDebugBtn) {
    toggleDebugBtn.addEventListener('click', () => {
      if (debugBox) debugBox.hidden = !debugBox.hidden;
    });
  }

  if (copyDebugBtn) {
    copyDebugBtn.addEventListener('click', async () => {
      if (debugOutput) {
        await navigator.clipboard?.writeText(debugOutput.textContent).catch(() => {});
        showToast('Diagnostics log copied to clipboard!');
      }
    });
  }

  subscribeApiLogs((line, full) => {
    if (debugOutput) {
      debugOutput.textContent = full;
      debugOutput.scrollTop = debugOutput.scrollHeight;
    }
  });

  $('single-reel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('single-reel-url').value.trim();
    const statusEl = $('single-reel-status');
    const extractBtn = $('extract-reel-btn');
    statusEl.innerHTML = '<span class="muted">Starting extraction...</span>';
    $('reel-fallback-box').hidden = true;
    if (extractBtn) {
      extractBtn.disabled = true;
      extractBtn.textContent = 'Extracting...';
    }

    logApi(`--- NEW REEL EXTRACTION ---`);
    logApi(`Target URL: ${url}`);

    try {
      const result = await runSingleReelExtraction(url, '', (msg) => {
        statusEl.textContent = msg;
        logApi(`[Progress] ${msg}`);
      });
      if (result.status === 'blocked') {
        logApi(`Extraction requires manual fallback: ${result.message}`);
        statusEl.innerHTML = `<span style="color: #b42318; font-weight: 600;">⚠ ${escapeHtml(result.message)}</span>`;
        $('reel-fallback-box').hidden = false;
        $('fallback-caption-text').value = result.rawCaption || '';
        $('fallback-caption-text').dataset.sourceUrl = url;
        if (debugBox) debugBox.hidden = false;
      } else {
        logApi(`Extraction successful. Saving recipe "${result.recipe.title}"...`);
        const id = await saveRecipe(state.user.uid, {
          ...result.recipe,
          source: 'Reel',
          sourceUrl: result.recipe.sourceUrl || url,
        });
        statusEl.textContent = `Saved "${result.recipe.title}"!`;
        $('single-reel-url').value = '';
        await refreshLibrary();
        openRecipeDetail(id);
      }
    } catch (err) {
      logApi(`ERROR: ${err.name} - ${err.message}`);
      console.error('[Reel Extraction Error]', err);
      statusEl.innerHTML = `<span style="color: #b42318; font-weight: 600;">Failed: ${escapeHtml(err.message)}</span>`;
      // Open debug box and fallback immediately so user can inspect and paste caption
      if (debugBox) debugBox.hidden = false;
      $('reel-fallback-box').hidden = false;
      $('fallback-caption-text').dataset.sourceUrl = url;
      showToast(err.message, true);
    } finally {
      if (extractBtn) {
        extractBtn.disabled = false;
        extractBtn.textContent = 'Extract Recipe from Reel';
      }
    }
  });

  $('fallback-extract-btn').addEventListener('click', async () => {
    const text = $('fallback-caption-text').value.trim();
    const sourceUrl = $('fallback-caption-text').dataset.sourceUrl || null;
    if (!text) return showToast('Paste the Reel caption or text first.', true);
    try {
      const recipe = await runCaptionFallbackExtraction(text, sourceUrl, (msg) => {
        $('single-reel-status').textContent = msg;
      });
      const id = await saveRecipe(state.user.uid, {
        ...recipe,
        source: 'Reel',
        sourceUrl: sourceUrl || recipe.sourceUrl,
      });
      $('reel-fallback-box').hidden = true;
      $('fallback-caption-text').value = '';
      await refreshLibrary();
      openRecipeDetail(id);
      showToast(`Saved "${recipe.title}"!`);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Paste raw text tab
  $('paste-text-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('paste-raw-text').value.trim();
    const sourceUrl = $('paste-raw-url').value.trim() || null;
    if (!text) return;
    $('paste-text-status').textContent = 'Parsing recipe via Gemini...';
    try {
      const recipe = await runCaptionFallbackExtraction(text, sourceUrl, (msg) => {
        $('paste-text-status').textContent = msg;
      });
      const id = await saveRecipe(state.user.uid, {
        ...recipe,
        source: 'Manual',
        sourceUrl: sourceUrl || recipe.sourceUrl,
      });
      $('paste-raw-text').value = '';
      $('paste-raw-url').value = '';
      $('paste-text-status').textContent = '';
      await refreshLibrary();
      openRecipeDetail(id);
    } catch (err) {
      $('paste-text-status').textContent = err.message;
      showToast(err.message, true);
    }
  });

  // --- Persistent Batch Import Queue & Attempt Logs ---

  const switchBatchSubtab = (targetSubtab) => {
    document.querySelectorAll('[data-batch-subtab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.batchSubtab === targetSubtab);
    });
    for (const p of ['new-batch', 'active-queue', 'unparsable', 'past-logs']) {
      const pane = $(`subpane-${p}`);
      if (pane) pane.hidden = p !== targetSubtab;
    }
    if (targetSubtab === 'active-queue' || targetSubtab === 'unparsable') {
      refreshImportQueue().catch(console.warn);
    } else if (targetSubtab === 'past-logs') {
      refreshImportLogs().catch(console.warn);
    }
  };

  document.querySelectorAll('[data-batch-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => switchBatchSubtab(btn.dataset.batchSubtab));
  });

  const renderQueueCountdownTimers = () => {
    const now = Date.now();
    document.querySelectorAll('[data-next-retry]').forEach((el) => {
      const nextMs = Number(el.dataset.nextRetry);
      if (nextMs) {
        const remaining = nextMs - now;
        if (remaining <= 0) {
          el.textContent = 'Ready to retry';
          el.className = 'chip chip-ready';
        } else {
          el.textContent = `⏳ Retry in ${formatCountdown(remaining)}`;
        }
      }
    });
  };

  const switchToSingleReelFallback = (url) => {
    document.querySelectorAll('[data-import-tab]').forEach((b) =>
      b.classList.toggle('active', b.dataset.importTab === 'single-reel')
    );
    for (const pane of ['single-reel', 'batch-whatsapp', 'onenote', 'zip', 'paste-text']) {
      $(`pane-${pane}`).hidden = pane !== 'single-reel';
    }
    const singleUrlInput = $('single-reel-url');
    if (singleUrlInput) singleUrlInput.value = url;
    const fallbackBox = $('reel-fallback-box');
    if (fallbackBox) fallbackBox.hidden = false;
    const captionText = $('fallback-caption-text');
    if (captionText) captionText.focus();
    showToast('Switched to Single Reel tab. Paste caption or recipe text to extract with Gemini!');
  };

  const refreshImportQueue = async () => {
    if (!state.user) return;
    try {
      state.importQueue = await loadUserImportQueue(state.user.uid);
    } catch (err) {
      console.warn('Failed loading import queue:', err);
      return;
    }

    const { ready, waiting, unparsable, processing } = classifyQueueItems(state.importQueue);
    const activeCount = ready.length + waiting.length + processing.length;

    // Badges
    const queueBadge = $('batch-queue-badge');
    if (queueBadge) {
      queueBadge.textContent = String(activeCount);
      queueBadge.hidden = activeCount === 0;
    }
    const unparsableBadge = $('batch-unparsable-badge');
    if (unparsableBadge) {
      unparsableBadge.textContent = String(unparsable.length);
      unparsableBadge.hidden = unparsable.length === 0;
    }

    // Alert Banner
    const banner = $('batch-alert-banner');
    if (banner) {
      if (unparsable.length > 0) {
        banner.innerHTML = `<span>⚠️ <strong>${unparsable.length} unparsable URL(s)</strong> reached 10 failed attempts.</span> <button type="button" class="btn-ghost btn-sm" id="banner-view-unparsable-btn">View Unparsable URLs</button>`;
        banner.hidden = false;
        $('banner-view-unparsable-btn')?.addEventListener('click', () => switchBatchSubtab('unparsable'));
      } else if (waiting.length > 0) {
        const nextTime = formatCountdown((Number(waiting[0].nextRetryAt) || 0) - Date.now());
        banner.innerHTML = `<span>⏳ <strong>${waiting.length} failed item(s)</strong> waiting on 10-minute retry cooldown (next in ${nextTime}). Auto-retrying while tab is open.</span> <button type="button" class="btn-ghost btn-sm" id="banner-view-queue-btn">View Queue</button>`;
        banner.hidden = false;
        $('banner-view-queue-btn')?.addEventListener('click', () => switchBatchSubtab('active-queue'));
      } else {
        banner.hidden = true;
      }
    }

    // Active Queue Card List
    const queueList = $('batch-queue-list');
    const queueStatusText = $('queue-status-text');
    if (queueStatusText) {
      queueStatusText.textContent = `${activeCount} item(s) active (${ready.length} ready, ${waiting.length} in 10-min cooldown, ${processing.length} processing).`;
    }

    if (queueList) {
      const activeItems = [...processing, ...ready, ...waiting];
      if (activeItems.length === 0) {
        queueList.innerHTML = '<div class="empty-state">No items waiting in active queue. Successful imports are automatically erased from table.</div>';
      } else {
        queueList.innerHTML = '';
        activeItems.forEach((item) => {
          const card = document.createElement('div');
          card.className = 'queue-item-card';

          const isProc = item.status === 'processing';
          const isFailed = item.status === 'failed';
          const isPending = item.status === 'pending';
          const now = Date.now();
          const msLeft = (Number(item.nextRetryAt) || 0) - now;
          const isReady = isPending || (isFailed && msLeft <= 0);

          let chipHtml = '';
          if (isProc) {
            chipHtml = '<span class="chip chip-processing">Processing...</span>';
          } else if (isReady) {
            chipHtml = `<span class="chip chip-ready">Ready to retry</span> <span class="muted small">(Attempt ${item.attempts || 0}/10)</span>`;
          } else {
            chipHtml = `<span class="chip chip-cooldown" data-next-retry="${item.nextRetryAt}">⏳ Retry in ${formatCountdown(msLeft)}</span> <span class="muted small">(Attempt ${item.attempts}/10)</span>`;
          }

          card.innerHTML = `
            <div class="queue-item-header">
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="queue-url">${escapeHtml(item.url)}</a>
              <div class="queue-badges">${chipHtml}</div>
            </div>
            ${item.lastError ? `<div class="queue-error-preview">Last error: ${escapeHtml(item.lastError)}</div>` : ''}
            <div class="queue-actions">
              <button type="button" class="btn-secondary btn-sm" data-action="retry-single">Retry Now</button>
              <button type="button" class="btn-ghost btn-sm" data-action="paste-caption-single">Paste Caption</button>
              <button type="button" class="btn-ghost btn-sm" data-action="dismiss-single">Dismiss</button>
            </div>
          `;

          card.querySelector('[data-action="retry-single"]')?.addEventListener('click', () => {
            runBatchImport([item], true);
          });
          card.querySelector('[data-action="paste-caption-single"]')?.addEventListener('click', () => {
            switchToSingleReelFallback(item.url);
          });
          card.querySelector('[data-action="dismiss-single"]')?.addEventListener('click', async () => {
            await deleteQueueItem(item.id);
            await refreshImportQueue();
            showToast('Item dismissed from queue.');
          });

          queueList.appendChild(card);
        });
      }
    }

    // Unparsable List
    const unparsableList = $('batch-unparsable-list');
    if (unparsableList) {
      if (unparsable.length === 0) {
        unparsableList.innerHTML = '<div class="empty-state">No unparsable URLs. URLs that fail 10 retry attempts will be listed here.</div>';
      } else {
        unparsableList.innerHTML = '';
        unparsable.forEach((item) => {
          const card = document.createElement('div');
          card.className = 'queue-item-card unparsable';

          const history = item.history || [];
          const historyHtml = history
            .map(
              (h) => `
                <div class="history-item">
                  <div class="history-meta">Attempt ${h.attempt} • ${new Date(h.timestamp).toLocaleTimeString()}</div>
                  <div class="history-error">${escapeHtml(h.error)}</div>
                </div>
              `
            )
            .join('');

          card.innerHTML = `
            <div class="queue-item-header">
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="queue-url">${escapeHtml(item.url)}</a>
              <div class="queue-badges">
                <span class="chip chip-unparsable">10/10 Attempts Failed (Unparsable)</span>
              </div>
            </div>
            <div class="queue-error-preview">Last error: ${escapeHtml(item.lastError || 'Persistent extraction failure')}</div>
            <div class="queue-actions">
              <button type="button" class="btn-primary btn-sm" data-action="paste-caption">Paste Caption</button>
              <button type="button" class="btn-secondary btn-sm" data-action="reset-retry">Reset &amp; Retry</button>
              <button type="button" class="btn-ghost btn-sm" data-action="toggle-history">Attempt History (${history.length})</button>
              <button type="button" class="btn-danger btn-sm" data-action="dismiss">Dismiss</button>
            </div>
            <div class="history-drawer stack" hidden>
              <strong>Attempt History Log:</strong>
              ${historyHtml || '<div class="muted small">No detailed history recorded.</div>'}
            </div>
          `;

          const drawer = card.querySelector('.history-drawer');
          card.querySelector('[data-action="toggle-history"]')?.addEventListener('click', (e) => {
            drawer.hidden = !drawer.hidden;
            e.currentTarget.textContent = drawer.hidden
              ? `Attempt History (${history.length})`
              : 'Hide History';
          });
          card.querySelector('[data-action="paste-caption"]')?.addEventListener('click', () => {
            switchToSingleReelFallback(item.url);
          });
          card.querySelector('[data-action="reset-retry"]')?.addEventListener('click', async () => {
            await resetQueueItemForRetry(item.id);
            await refreshImportQueue();
            showToast('Item reset to pending. Retrying now...');
            runBatchImport([{ ...item, attempts: 0, status: 'pending' }], true);
          });
          card.querySelector('[data-action="dismiss"]')?.addEventListener('click', async () => {
            await deleteQueueItem(item.id);
            await refreshImportQueue();
            showToast('Unparsable URL dismissed.');
          });

          unparsableList.appendChild(card);
        });
      }
    }
  };

  const refreshImportLogs = async () => {
    if (!state.user) return;
    try {
      state.importLogs = await loadUserImportLogs(state.user.uid, 25);
    } catch (err) {
      console.warn('Failed loading import logs:', err);
      return;
    }

    const logsList = $('batch-past-logs-list');
    if (!logsList) return;

    if (state.importLogs.length === 0) {
      logsList.innerHTML = '<div class="empty-state">No past import logs recorded yet. Logs will appear here after running batch imports.</div>';
      return;
    }

    logsList.innerHTML = '';
    state.importLogs.forEach((log) => {
      const card = document.createElement('div');
      card.className = 'log-session-card';

      const dateStr = log.createdAtMs
        ? new Date(log.createdAtMs).toLocaleString()
        : 'Recent session';

      const details = log.details || [];
      const detailsLines = details
        .map((d) => {
          let icon = '⚪';
          if (d.status === 'saved') icon = '✅';
          else if (d.status === 'skipped') icon = '⏩';
          else if (d.status === 'blocked') icon = '⚠️';
          else if (d.status === 'failed') icon = '❌';
          else if (d.status === 'unparsable') icon = '🔴';
          return `<div>${icon} [${d.status.toUpperCase()}] ${escapeHtml(d.url)}: ${escapeHtml(d.title || d.message || '')}</div>`;
        })
        .join('');

      card.innerHTML = `
        <div class="card-header-row">
          <div>
            <strong>${escapeHtml(dateStr)}</strong>
            <div class="muted small">${log.totalUrls || details.length} total URL(s) processed</div>
          </div>
          <div class="log-metrics">
            <span class="chip chip-ready">✅ ${log.savedCount || 0} saved</span>
            <span class="chip chip-pending">⏩ ${log.skippedCount || 0} skipped</span>
            ${log.failedCount ? `<span class="chip chip-cooldown">❌ ${log.failedCount} failed</span>` : ''}
            ${log.blockedCount ? `<span class="chip chip-cooldown">⚠️ ${log.blockedCount} blocked</span>` : ''}
            ${log.unparsableCount ? `<span class="chip chip-unparsable">🔴 ${log.unparsableCount} unparsable</span>` : ''}
          </div>
        </div>
        <div class="row">
          <button type="button" class="btn-ghost btn-sm" data-action="toggle-details">Show Details (${details.length})</button>
          <button type="button" class="btn-ghost btn-sm" data-action="delete-log" data-id="${log.id}">Delete Log</button>
        </div>
        <div class="log-details-box stack" hidden>
          ${detailsLines || '<div class="muted">No event details recorded.</div>'}
        </div>
      `;

      const detailsBox = card.querySelector('.log-details-box');
      card.querySelector('[data-action="toggle-details"]')?.addEventListener('click', (e) => {
        detailsBox.hidden = !detailsBox.hidden;
        e.currentTarget.textContent = detailsBox.hidden
          ? `Show Details (${details.length})`
          : 'Hide Details';
      });
      card.querySelector('[data-action="delete-log"]')?.addEventListener('click', async () => {
        await deleteImportLog(log.id);
        await refreshImportLogs();
        showToast('Log entry removed.');
      });

      logsList.appendChild(card);
    });
  };

  // WhatsApp file picker
  $('whatsapp-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { items, duplicateCount, alreadySavedCount } = buildBatchQueue({
      urlsText: $('batch-urls-input').value,
      whatsappText: text,
      existingRecipes: state.recipes,
      includeAlreadySaved: true,
    });
    $('batch-urls-input').value = items.map((i) => i.url).join('\n');
    $('batch-summary').textContent =
      `Found ${items.length} Reel link(s) (${alreadySavedCount} already saved in library, ${duplicateCount} duplicate links in file).`;
    $('batch-urls-input').dataset.whatsappText = text;
    $('batch-retry-failed-btn').hidden = true;
  });

  const runBatchImport = async (targetItems = null, alreadyEnqueued = false) => {
    if (state.isBatchRunning) {
      return showToast('A batch import is already in progress. Please wait for it to complete.', true);
    }

    const whatsappText = $('batch-urls-input').dataset.whatsappText || '';
    const queue = targetItems || buildBatchQueue({
      urlsText: $('batch-urls-input').value,
      whatsappText,
      existingRecipes: state.recipes,
      includeAlreadySaved: true,
    }).items;

    if (!queue.length) {
      return showToast('No Reel URLs to process in queue.', true);
    }

    // Switch to new-batch subpane if starting fresh
    if (!targetItems) {
      switchBatchSubtab('new-batch');
    }

    const log = $('batch-log');
    log.hidden = false;
    log.innerHTML = '';
    $('batch-run-btn').disabled = true;
    $('batch-retry-failed-btn').hidden = true;
    state.isBatchRunning = true;

    try {
      const summary = await processBatchQueue(
        state.user.uid,
        queue,
        (evt) => {
          const line = document.createElement('div');
          line.className = 'batch-log-item';
          if (evt.type === 'wake') {
            line.textContent = `[Server] ${evt.message}`;
            line.classList.add('muted');
          } else if (evt.type === 'item_start') {
            line.textContent = `[${evt.index + 1}/${evt.total}] Processing ${evt.url} (Attempt ${(evt.attempts || 0) + 1})...`;
          } else if (evt.type === 'item_done') {
            if (evt.status === 'saved') {
              line.innerHTML = `✅ [${evt.index + 1}/${evt.total}] <strong>SAVED &amp; ERASED FROM QUEUE:</strong> "${escapeHtml(evt.title)}" <span class="muted">(${escapeHtml(evt.url)})</span>`;
              line.classList.add('log-success');
            } else if (evt.status === 'skipped') {
              line.innerHTML = `⏩ [${evt.index + 1}/${evt.total}] <strong>SKIPPED:</strong> Recipe already exists ("${escapeHtml(evt.title)}") <span class="muted">(${escapeHtml(evt.url)})</span>`;
              line.classList.add('log-skipped');
            } else if (evt.status === 'unparsable') {
              line.innerHTML = `🔴 [${evt.index + 1}/${evt.total}] <strong>UNPARSABLE (10 Attempts Reached):</strong> ${escapeHtml(evt.message)} <span class="muted">(${escapeHtml(evt.url)})</span>`;
              line.classList.add('log-error');
            } else if (evt.status === 'blocked') {
              line.innerHTML = `⚠️ [${evt.index + 1}/${evt.total}] <strong>BLOCKED:</strong> Scheduled retry in 10 minutes (${evt.attempts}/10): ${escapeHtml(evt.message)} <span class="muted">(${escapeHtml(evt.url)})</span>`;
              line.classList.add('log-warning');
            } else if (evt.status === 'failed') {
              line.innerHTML = `❌ [${evt.index + 1}/${evt.total}] <strong>FAILED:</strong> Scheduled retry in 10 minutes (${evt.attempts}/10): ${escapeHtml(evt.message)} <span class="muted">(${escapeHtml(evt.url)})</span>`;
              line.classList.add('log-error');
            }
          }
          log.appendChild(line);
          log.scrollTop = log.scrollHeight;
        },
        state.recipes,
        alreadyEnqueued
      );

      await refreshLibrary();
      await refreshImportQueue();
      await refreshImportLogs();

      const summaryMsg = `Batch complete: ${summary.saved} saved, ${summary.skipped} skipped, ${summary.failed.length + summary.blocked.length} scheduled for 10-min retry, ${summary.unparsable.length} unparsable.`;
      showToast(summaryMsg);

      const summaryLine = document.createElement('div');
      summaryLine.className = 'batch-log-item';
      summaryLine.style.marginTop = '0.5rem';
      summaryLine.style.fontWeight = '600';
      summaryLine.textContent = `--- Finished: ${summary.saved} saved & erased from queue, ${summary.skipped} already existed, ${summary.failed.length + summary.blocked.length} scheduled for 10-min retry, ${summary.unparsable.length} unparsable ---`;
      log.appendChild(summaryLine);

      const retryableItems = [...summary.blocked, ...summary.failed];
      if (retryableItems.length > 0) {
        state.lastBatchRetryableItems = retryableItems;
        const retryBtn = $('batch-retry-failed-btn');
        retryBtn.textContent = `Retry Failed / Blocked Now (${retryableItems.length})`;
        retryBtn.hidden = false;
      }
    } finally {
      state.isBatchRunning = false;
      $('batch-run-btn').disabled = false;
    }
  };

  $('batch-run-btn').addEventListener('click', () => runBatchImport());

  $('batch-retry-failed-btn').addEventListener('click', () => {
    if (state.lastBatchRetryableItems?.length) {
      runBatchImport(state.lastBatchRetryableItems, true);
    }
  });

  $('batch-clear-btn').addEventListener('click', () => {
    $('batch-urls-input').value = '';
    $('batch-urls-input').dataset.whatsappText = '';
    $('batch-summary').textContent = '';
    $('batch-log').innerHTML = '';
    $('batch-log').hidden = true;
    $('batch-retry-failed-btn').hidden = true;
    $('whatsapp-file-input').value = '';
  });

  // Action buttons for queue subpane
  $('queue-retry-ready-btn')?.addEventListener('click', () => {
    const { ready } = classifyQueueItems(state.importQueue);
    if (!ready.length) return showToast('No items currently ready for retry.', true);
    runBatchImport(ready, true);
  });

  $('queue-retry-all-btn')?.addEventListener('click', () => {
    const { ready, waiting } = classifyQueueItems(state.importQueue);
    const all = [...ready, ...waiting];
    if (!all.length) return showToast('No pending or failed items in queue.', true);
    runBatchImport(all, true);
  });

  $('queue-refresh-btn')?.addEventListener('click', () => refreshImportQueue());

  // Action buttons for unparsable subpane
  $('unparsable-refresh-btn')?.addEventListener('click', () => refreshImportQueue());

  $('unparsable-clear-all-btn')?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to dismiss and clear all unparsable URLs?')) return;
    await clearAllUnparsableItems(state.user.uid);
    await refreshImportQueue();
    showToast('All unparsable URLs cleared.');
  });

  // Action buttons for past logs subpane
  $('logs-refresh-btn')?.addEventListener('click', () => refreshImportLogs());

  // Interval: live countdowns every 5s & auto-retry check when tab is open
  setInterval(async () => {
    renderQueueCountdownTimers();

    if (!state.user || state.isBatchRunning) return;

    // Check if any items in importQueue are failed and reached their 10-minute cooldown
    const now = Date.now();
    const readyToAutoRetry = (state.importQueue || []).filter(
      (item) => item.status === 'failed' && Number(item.nextRetryAt) <= now
    );

    if (readyToAutoRetry.length > 0) {
      console.log(`[Auto-Retry] Triggering batch for ${readyToAutoRetry.length} ready item(s)...`);
      showToast(`Auto-retrying ${readyToAutoRetry.length} failed item(s) whose 10-minute cooldown elapsed...`);
      await runBatchImport(readyToAutoRetry, true);
    }
  }, 10000);

  // OneNote importer
  $('onenote-parse-btn').addEventListener('click', async () => {
    const file = $('onenote-file-input').files?.[0];
    if (!file) return showToast('Select an exported OneNote .html, .docx, or .pdf file.', true);
    $('onenote-status').textContent = 'Uploading & parsing via Gemini...';
    try {
      const result = await extractRecipesFromOneNoteFile(file, (msg) => {
        $('onenote-status').textContent = msg;
      });
      state.pendingOneNoteRecipes = result.recipes || [];
      state.pendingOneNoteUnparsed = result.unparsed || [];
      state.pendingOneNoteFailed = [];
      const unparsedCount = state.pendingOneNoteUnparsed.length;
      $('onenote-status').textContent = `Parsed ${state.pendingOneNoteRecipes.length} recipe(s)${unparsedCount ? ` (${unparsedCount} incomplete/unparsed note(s) to review)` : ''}.`;
      renderOneNotePreview();
    } catch (err) {
      $('onenote-status').textContent = err.message;
      showToast(err.message, true);
    }
  });

  $('onenote-select-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.onenote-pick').forEach((cb) => (cb.checked = true));
    updateOneNoteSaveBtnText();
  });

  $('onenote-deselect-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.onenote-pick').forEach((cb) => (cb.checked = false));
    updateOneNoteSaveBtnText();
  });

  $('onenote-preview-list')?.addEventListener('change', (e) => {
    if (e.target.classList.contains('onenote-pick')) {
      updateOneNoteSaveBtnText();
    }
  });

  $('onenote-save-btn').addEventListener('click', async () => {
    const selectedIndices = Array.from(document.querySelectorAll('.onenote-pick:checked')).map((cb) =>
      Number(cb.dataset.idx)
    );
    if (!selectedIndices.length) {
      return showToast('No recipes selected to import.', true);
    }

    $('onenote-save-btn').disabled = true;
    $('onenote-status').textContent = `Importing ${selectedIndices.length} recipe(s)...`;

    let saved = 0;
    let skipped = 0;
    let failed = 0;
    const sessionLogDetails = [];
    const remainingRecipes = [];

    // Map existing recipe titles for deduplication (prevent overwrites)
    const existingTitles = new Set(
      state.recipes.map((r) => (r.title || '').trim().toLowerCase()).filter(Boolean)
    );

    for (let i = 0; i < state.pendingOneNoteRecipes.length; i += 1) {
      const recipe = state.pendingOneNoteRecipes[i];
      if (!selectedIndices.includes(i)) {
        remainingRecipes.push(recipe);
        continue;
      }

      const normTitle = (recipe.title || '').trim().toLowerCase();
      if (normTitle && existingTitles.has(normTitle)) {
        skipped += 1;
        sessionLogDetails.push({
          url: recipe.sourceUrl || `OneNote:${recipe.title}`,
          status: 'skipped',
          title: recipe.title,
          message: `Recipe already exists ("${recipe.title}") - skipped to prevent overwrite.`,
          timestamp: Date.now(),
        });
        continue;
      }

      try {
        await saveRecipe(state.user.uid, {
          ...recipe,
          source: 'OneNote',
          tags: recipe.tags?.includes('OneNote') ? recipe.tags : [...(recipe.tags || []), 'OneNote'],
        });
        saved += 1;
        if (normTitle) existingTitles.add(normTitle);
        sessionLogDetails.push({
          url: recipe.sourceUrl || `OneNote:${recipe.title}`,
          status: 'saved',
          title: recipe.title,
          timestamp: Date.now(),
        });
      } catch (err) {
        failed += 1;
        state.pendingOneNoteFailed.push({
          title: recipe.title,
          error: err.message,
          recipe,
        });
        sessionLogDetails.push({
          url: recipe.sourceUrl || `OneNote:${recipe.title}`,
          status: 'failed',
          title: recipe.title,
          message: err.message,
          timestamp: Date.now(),
        });
      }
    }

    // Record session execution log in Firestore importLogs
    try {
      await saveImportSessionLog(state.user.uid, {
        totalUrls: selectedIndices.length,
        savedCount: saved,
        skippedCount: skipped,
        failedCount: failed,
        unparsableCount: (state.pendingOneNoteUnparsed || []).length,
        summaryText: `OneNote import: ${saved} saved, ${skipped} skipped (already existed), ${failed} failed.`,
        details: sessionLogDetails,
      });
    } catch (logErr) {
      console.warn('Failed saving OneNote import log:', logErr);
    }

    state.pendingOneNoteRecipes = remainingRecipes;
    renderOneNotePreview();
    await refreshLibrary();
    await refreshImportLogs();

    $('onenote-save-btn').disabled = false;
    $('onenote-status').textContent = `Finished: ${saved} saved, ${skipped} skipped (already in library), ${failed} failed.`;
    showToast(`OneNote import: ${saved} saved, ${skipped} skipped, ${failed} failed.`);
  });

  // ==========================================
  // Zip Archive (.zip) Importer
  // ==========================================

  const loadZipSamplePackage = async (sampleName, displayName) => {
    const statusEl = $('zip-status');
    if (statusEl) {
      statusEl.className = 'status-box muted';
      statusEl.textContent = `Loading ${displayName}...`;
    }
    try {
      const res = await fetch(`assets/samples/${sampleName}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load ${displayName}`);
      const recipes = await res.json();
      state.pendingZipRecipes = recipes;
      renderZipPreview();
      if (statusEl) {
        statusEl.className = 'status-box success';
        statusEl.textContent = `✅ Loaded ${recipes.length} recipes from "${displayName}". All recipes are pre-selected below. Click "Import Selected Recipes" to save them to your library.`;
      }
      $('zip-preview-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'status-box error';
        statusEl.textContent = `❌ Failed to load sample package: ${err.message}`;
      }
      showToast(err.message, true);
    }
  };

  $('zip-quick-all-btn')?.addEventListener('click', () => {
    loadZipSamplePackage('all_samples', 'All 3 Collections (54 Recipes)');
  });
  $('zip-quick-soups-btn')?.addEventListener('click', () => {
    loadZipSamplePackage('soups', 'Soups Collection (10 Recipes)');
  });
  $('zip-quick-salads-btn')?.addEventListener('click', () => {
    loadZipSamplePackage('salads', 'Salads Collection (21 Recipes)');
  });
  $('zip-quick-sides-btn')?.addEventListener('click', () => {
    loadZipSamplePackage('sides', 'Sides Collection (23 Recipes)');
  });

  $('zip-clear-file-btn')?.addEventListener('click', () => {
    const fileInput = $('zip-file-input');
    if (fileInput) fileInput.value = '';
    const statusEl = $('zip-status');
    if (statusEl) {
      statusEl.className = 'status-box muted';
      statusEl.textContent = '';
    }
    state.pendingZipRecipes = [];
    renderZipPreview();
  });

  const processUploadedZip = async () => {
    const file = $('zip-file-input')?.files?.[0];
    const statusEl = $('zip-status');
    if (!file) {
      if (statusEl) {
        statusEl.className = 'status-box error';
        statusEl.textContent = 'Please choose a .zip file to upload.';
      }
      return showToast('Please choose a .zip file to upload.', true);
    }

    if (statusEl) {
      statusEl.className = 'status-box muted';
      statusEl.textContent = 'Checking zip format (recipes.json + images/)...';
    }

    try {
      const validation = await validateZipArchive(file);
      if (!validation.valid) {
        if (statusEl) {
          statusEl.className = 'status-box error';
          statusEl.textContent = `❌ Format Error: ${validation.error}\n\nPlease verify that your .zip file contains a "recipes.json" file and an optional "images/" folder.`;
        }
        state.pendingZipRecipes = [];
        renderZipPreview();
        return showToast(validation.error, true);
      }

      if (statusEl) {
        statusEl.className = 'status-box muted';
        statusEl.textContent = `Format verified (${validation.recipesRaw.length} recipes, ${validation.imageCount} images). Extracting and structuring Hebrew recipe data...`;
      }

      const result = await extractRecipesFromZip(file, (p) => {
        if (statusEl) {
          statusEl.textContent = `Extracting recipe ${p.index} of ${p.total}: "${p.recipe.title}"...`;
        }
      });

      state.pendingZipRecipes = result.recipes || [];
      renderZipPreview();

      if (statusEl) {
        statusEl.className = 'status-box success';
        statusEl.textContent = `✅ Format verified! Successfully extracted ${result.recipes.length} recipes and ${result.imageCount} photos. Select the recipes you wish to import below.`;
      }
      $('zip-preview-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'status-box error';
        statusEl.textContent = `❌ Error reading zip: ${err.message}`;
      }
      state.pendingZipRecipes = [];
      renderZipPreview();
      showToast(err.message, true);
    }
  };

  $('zip-verify-btn')?.addEventListener('click', processUploadedZip);
  $('zip-file-input')?.addEventListener('change', () => {
    const file = $('zip-file-input')?.files?.[0];
    if (file) {
      processUploadedZip();
    }
  });

  $('zip-select-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.zip-pick').forEach((cb) => (cb.checked = true));
    updateZipSaveBtnText();
  });

  $('zip-deselect-all-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.zip-pick').forEach((cb) => (cb.checked = false));
    updateZipSaveBtnText();
  });

  $('zip-preview-list')?.addEventListener('change', (e) => {
    if (e.target.classList.contains('zip-pick')) {
      updateZipSaveBtnText();
    }
  });

  $('zip-save-btn')?.addEventListener('click', async () => {
    const selectedIndices = Array.from(document.querySelectorAll('.zip-pick:checked')).map((cb) =>
      Number(cb.dataset.idx)
    );
    if (!selectedIndices.length) {
      return showToast('Select at least one recipe to import.', true);
    }

    const saveBtn = $('zip-save-btn');
    const statusEl = $('zip-status');
    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) {
      statusEl.className = 'status-box muted';
      statusEl.textContent = `Importing ${selectedIndices.length} recipe(s) to library...`;
    }

    let saved = 0;
    let skipped = 0;
    let failed = 0;
    const sessionLogDetails = [];
    const remainingRecipes = [];

    const existingTitles = new Set(
      state.recipes.map((r) => (r.title || '').trim().toLowerCase()).filter(Boolean)
    );

    for (let i = 0; i < state.pendingZipRecipes.length; i += 1) {
      const recipe = state.pendingZipRecipes[i];
      if (!selectedIndices.includes(i)) {
        remainingRecipes.push(recipe);
        continue;
      }

      const normTitle = (recipe.title || '').trim().toLowerCase();
      if (normTitle && existingTitles.has(normTitle)) {
        skipped += 1;
        sessionLogDetails.push({
          url: recipe.sourceUrl || `Zip:${recipe.title}`,
          status: 'skipped',
          title: recipe.title,
          message: `Recipe already exists ("${recipe.title}") - skipped to prevent overwrite.`,
          timestamp: Date.now(),
        });
        continue;
      }

      try {
        await saveRecipe(state.user.uid, {
          ...recipe,
          source: recipe.source || 'OneNote (PDF)',
          tags: Array.from(new Set(['OneNote', recipe.category, ...(recipe.tags || [])])).filter(Boolean),
        });
        saved += 1;
        if (normTitle) existingTitles.add(normTitle);
        sessionLogDetails.push({
          url: recipe.sourceUrl || `Zip:${recipe.title}`,
          status: 'saved',
          title: recipe.title,
          timestamp: Date.now(),
        });
      } catch (err) {
        failed += 1;
        remainingRecipes.push(recipe);
        sessionLogDetails.push({
          url: recipe.sourceUrl || `Zip:${recipe.title}`,
          status: 'failed',
          title: recipe.title,
          message: err.message,
          timestamp: Date.now(),
        });
      }
    }

    try {
      await saveImportSessionLog(state.user.uid, {
        totalUrls: selectedIndices.length,
        savedCount: saved,
        skippedCount: skipped,
        failedCount: failed,
        unparsableCount: 0,
        summaryText: `Zip archive import: ${saved} saved, ${skipped} skipped (already existed), ${failed} failed.`,
        details: sessionLogDetails,
      });
    } catch (logErr) {
      console.warn('Failed saving Zip import log:', logErr);
    }

    state.pendingZipRecipes = remainingRecipes;
    renderZipPreview();
    await refreshLibrary();
    await refreshImportLogs();

    if (saveBtn) saveBtn.disabled = false;
    const finalMsg = `Zip import finished: ${saved} saved, ${skipped} skipped (already existed), ${failed} failed.`;
    if (statusEl) {
      statusEl.className = failed ? 'status-box error' : 'status-box success';
      statusEl.textContent = `✅ ${finalMsg}`;
    }
    showToast(finalMsg);
  });

  // Shopping list actions
  $('shopping-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('shopping-new-item');
    if (!input.value.trim()) return;
    await addSingleShoppingItem(state.user.uid, input.value);
    input.value = '';
    await refreshShoppingList();
  });

  $('shopping-clear-btn').addEventListener('click', async () => {
    await clearCheckedShoppingItems(state.shoppingItems);
    await refreshShoppingList();
  });

  // Settings & Export
  $('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveAppConfig({ apiUrl: $('settings-api-url').value.trim() });
    showToast('Settings saved on this device.');
  });

  // Export filters changes
  ['export-filter-category', 'export-filter-dietary', 'export-filter-tag', 'export-filter-language'].forEach((id) => {
    $(id)?.addEventListener('change', updateExportMatchCount);
  });

  // Export actions
  $('export-pdf-btn')?.addEventListener('click', () => {
    const matches = filterRecipesForExport(state.recipes, getExportFilters());
    if (!matches.length) return showToast('No matching recipes to export.', true);
    exportRecipesToPdf(matches, { title: 'Recipe Manager Cookbook' });
  });

  $('export-md-btn')?.addEventListener('click', () => {
    const matches = filterRecipesForExport(state.recipes, getExportFilters());
    if (!matches.length) return showToast('No matching recipes to export.', true);
    downloadTextFile('recipes-export.md', recipesToMarkdown(matches), 'text/markdown');
    showToast(`Exported ${matches.length} recipe(s) to Markdown!`);
  });

  $('export-json-btn')?.addEventListener('click', () => {
    const matches = filterRecipesForExport(state.recipes, getExportFilters());
    if (!matches.length) return showToast('No matching recipes to export.', true);
    downloadTextFile('recipes-export.json', recipesToJson(matches), 'application/json');
    showToast(`Exported ${matches.length} recipe(s) to JSON!`);
  });
}

function init() {
  bindEvents();
  const cfg = getAppConfig();
  if ($('settings-api-url')) {
    $('settings-api-url').value = cfg.apiUrl;
  }

  try {
    subscribeAuth(async (user) => {
      state.user = user;
      if (!user) {
        switchTopLevelScreen('auth-screen');
        return;
      }
      $('user-label').textContent = user.email || user.displayName || 'Signed in';
      switchTopLevelScreen('app-shell');
      switchView('library');
      try {
        await Promise.all([
          refreshLibrary(),
          refreshShoppingList(),
          refreshImportQueue().catch(console.warn),
          refreshImportLogs().catch(console.warn),
        ]);
      } catch (dbErr) {
        console.error('Failed loading library/shopping list/queue:', dbErr);
      }
    });
  } catch (err) {
    console.error('Failed to initialize Firebase Auth:', err);
    switchTopLevelScreen('auth-screen');
  }
}

init();
