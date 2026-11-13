/**
 * Main SPA controller for Recipe Manager.
 */

import { translateRecipe } from './api.js?v=3';
import {
  DEFAULT_API_URL,
  DEFAULT_FIREBASE_CONFIG,
  getAppConfig,
  isFirebaseConfigured,
  saveAppConfig,
} from './config.js?v=3';
import { isWakeLockActive, setWakeLockEnabled } from './cook-mode.js?v=3';
import { downloadTextFile, recipesToJson, recipesToMarkdown } from './export.js?v=3';
import {
  logoutUser,
  registerWithEmail,
  signInWithEmail,
  signInWithGoogle,
  subscribeAuth,
} from './firebase-client.js?v=3';
import {
  buildBatchQueue,
  extractRecipesFromOneNoteFile,
  processBatchQueue,
  runCaptionFallbackExtraction,
  runSingleReelExtraction,
} from './importer.js?v=3';
import {
  compressImageToDataUri,
  createOrUpdateShareLink,
  deleteRecipeById,
  filterRecipes,
  loadUserRecipes,
  saveRecipe,
} from './recipes.js?v=3';
import { applyDirection } from './rtl.js?v=3';
import {
  addShoppingItems,
  addSingleShoppingItem,
  clearCheckedShoppingItems,
  loadShoppingList,
  removeShoppingItem,
  toggleShoppingItem,
} from './shopping-list.js?v=3';

const state = {
  user: null,
  recipes: [],
  shoppingItems: [],
  activeView: 'library',
  selectedRecipeId: null,
  editingRecipeId: null,
  pendingThumbnailDataUri: '',
  pendingOneNoteRecipes: [],
  filters: { search: '', category: 'ALL', language: 'ALL', dietary: 'ALL' },
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
  for (const id of ['setup-screen', 'auth-screen', 'app-shell']) {
    $(id).hidden = id !== screenId;
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
  state.recipes = await loadUserRecipes(state.user.uid);
  populateCategoryFilter();
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

    const stars = recipe.rating ? '★'.repeat(recipe.rating) + '☆'.repeat(5 - recipe.rating) : '';
    const chips = [
      recipe.category,
      recipe.language === 'he' ? 'עברית' : 'EN',
      ...(recipe.dietary || []).slice(0, 2),
    ]
      .filter(Boolean)
      .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
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
  const metaChips = [
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
    span.className = 'chip';
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
  container.innerHTML = '';
  if (!state.pendingOneNoteRecipes.length) {
    $('onenote-save-btn').hidden = true;
    return;
  }

  $('onenote-save-btn').hidden = false;
  state.pendingOneNoteRecipes.forEach((recipe, idx) => {
    const row = document.createElement('div');
    row.className = 'preview-item';
    applyDirection(row, recipe.title, recipe.language);
    row.innerHTML = `
      <label>
        <input type="checkbox" class="onenote-pick" data-idx="${idx}" checked />
        <strong>${escapeHtml(recipe.title)}</strong>
        <span class="chip">${escapeHtml(recipe.language)}</span>
        <span class="chip">${(recipe.ingredients || []).length} ingredients</span>
      </label>
    `;
    container.appendChild(row);
  });
}

function bindEvents() {
  // Setup wizard form
  $('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const fbJson = JSON.parse($('setup-firebase-json').value.trim());
      const apiUrl = $('setup-api-url').value.trim();
      saveAppConfig({ firebase: fbJson, apiUrl });
      window.location.reload();
    } catch (err) {
      showToast(`Invalid Firebase JSON config: ${err.message}`, true);
    }
  });

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

    const id = await saveRecipe(
      state.user.uid,
      {
        title: $('edit-title').value,
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
      for (const pane of ['single-reel', 'batch-whatsapp', 'onenote', 'paste-text']) {
        $(`pane-${pane}`).hidden = pane !== target;
      }
    });
  });

  // Single Reel extraction + fallback
  $('single-reel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('single-reel-url').value.trim();
    const statusEl = $('single-reel-status');
    $('reel-fallback-box').hidden = true;
    try {
      const result = await runSingleReelExtraction(url, '', (msg) => {
        statusEl.textContent = msg;
      });
      if (result.status === 'blocked') {
        statusEl.textContent = result.message;
        $('reel-fallback-box').hidden = false;
        $('fallback-caption-text').value = result.rawCaption || '';
        $('fallback-caption-text').dataset.sourceUrl = url;
      } else {
        const id = await saveRecipe(state.user.uid, result.recipe);
        statusEl.textContent = `Saved "${result.recipe.title}"!`;
        $('single-reel-url').value = '';
        await refreshLibrary();
        openRecipeDetail(id);
      }
    } catch (err) {
      statusEl.textContent = err.message;
      showToast(err.message, true);
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
      const id = await saveRecipe(state.user.uid, recipe);
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
      const id = await saveRecipe(state.user.uid, recipe);
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

  // Batch & WhatsApp importer
  $('whatsapp-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { items, duplicateCount, alreadySavedCount } = buildBatchQueue({
      urlsText: $('batch-urls-input').value,
      whatsappText: text,
      existingRecipes: state.recipes,
    });
    $('batch-urls-input').value = items.map((i) => i.url).join('\n');
    $('batch-summary').textContent =
      `Found ${items.length} new Reel link(s) (${alreadySavedCount} already saved, ${duplicateCount} duplicates skipped).`;
    $('batch-urls-input').dataset.whatsappText = text;
  });

  $('batch-run-btn').addEventListener('click', async () => {
    const whatsappText = $('batch-urls-input').dataset.whatsappText || '';
    const { items } = buildBatchQueue({
      urlsText: $('batch-urls-input').value,
      whatsappText,
      existingRecipes: state.recipes,
    });
    if (!items.length) {
      return showToast('No new Facebook or Instagram Reel URLs to process.', true);
    }

    const log = $('batch-log');
    log.innerHTML = '';
    $('batch-run-btn').disabled = true;
    try {
      const summary = await processBatchQueue(state.user.uid, items, (evt) => {
        const line = document.createElement('div');
        if (evt.type === 'wake') line.textContent = evt.message;
        else if (evt.type === 'item_start')
          line.textContent = `[${evt.index + 1}/${evt.total}] Processing ${evt.url}...`;
        else if (evt.type === 'item_done')
          line.textContent = `  -> ${evt.status.toUpperCase()}: ${evt.title || evt.message || evt.url}`;
        log.appendChild(line);
      });
      await refreshLibrary();
      showToast(`Batch finished: ${summary.saved} saved, ${summary.blocked.length} blocked, ${summary.failed.length} failed.`);
    } finally {
      $('batch-run-btn').disabled = false;
    }
  });

  // OneNote importer
  $('onenote-parse-btn').addEventListener('click', async () => {
    const file = $('onenote-file-input').files?.[0];
    if (!file) return showToast('Select an exported OneNote .html, .docx, or .pdf file.', true);
    $('onenote-status').textContent = 'Uploading & parsing via Gemini...';
    try {
      state.pendingOneNoteRecipes = await extractRecipesFromOneNoteFile(file, (msg) => {
        $('onenote-status').textContent = msg;
      });
      $('onenote-status').textContent = `Found ${state.pendingOneNoteRecipes.length} recipe(s).`;
      renderOneNotePreview();
    } catch (err) {
      $('onenote-status').textContent = err.message;
      showToast(err.message, true);
    }
  });

  $('onenote-save-btn').addEventListener('click', async () => {
    const selectedIndices = Array.from(document.querySelectorAll('.onenote-pick:checked')).map((cb) =>
      Number(cb.dataset.idx)
    );
    let saved = 0;
    for (const idx of selectedIndices) {
      const recipe = state.pendingOneNoteRecipes[idx];
      if (recipe) {
        await saveRecipe(state.user.uid, recipe);
        saved += 1;
      }
    }
    state.pendingOneNoteRecipes = [];
    renderOneNotePreview();
    await refreshLibrary();
    showToast(`Imported ${saved} OneNote recipe(s)!`);
    switchView('library');
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

  $('export-json-btn').addEventListener('click', () => {
    downloadTextFile('recipes-backup.json', recipesToJson(state.recipes), 'application/json');
  });
  $('export-md-btn').addEventListener('click', () => {
    downloadTextFile('recipes-backup.md', recipesToMarkdown(state.recipes), 'text/markdown');
  });
}

function init() {
  bindEvents();
  const cfg = getAppConfig();
  $('settings-api-url').value = cfg.apiUrl;

  const setupFbInput = $('setup-firebase-json');
  if (setupFbInput && !setupFbInput.value.trim()) {
    setupFbInput.value = JSON.stringify(DEFAULT_FIREBASE_CONFIG, null, 2);
  }
  const setupApiInput = $('setup-api-url');
  if (setupApiInput && !setupApiInput.value.trim()) {
    setupApiInput.value = DEFAULT_API_URL;
  }

  if (!isFirebaseConfigured(cfg)) {
    switchTopLevelScreen('setup-screen');
    return;
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
      await Promise.all([refreshLibrary(), refreshShoppingList()]);
    });
  } catch (err) {
    console.error('Failed to initialize Firebase Auth:', err);
    switchTopLevelScreen('auth-screen');
  }
}

init();
