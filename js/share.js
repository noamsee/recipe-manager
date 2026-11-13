/**
 * Public read-only shared recipe page logic (share.html?id=<shareId>).
 */

import { isFirebaseConfigured } from './config.js?v=3';
import { loadSharedRecipe } from './recipes.js?v=3';
import { applyDirection } from './rtl.js?v=3';
import { setWakeLockEnabled } from './cook-mode.js?v=3';

const root = document.getElementById('share-root');
const wakeBtn = document.getElementById('share-wake-btn');

async function init() {
  const params = new URLSearchParams(window.location.search);
  const shareId = params.get('id');
  if (!shareId) {
    root.innerHTML = '<div class="empty-state">Missing recipe share ID.</div>';
    return;
  }
  if (!isFirebaseConfigured()) {
    root.innerHTML = '<div class="empty-state">Firebase is not configured for this site yet.</div>';
    return;
  }

  try {
    const recipe = await loadSharedRecipe(shareId);
    if (!recipe) {
      root.innerHTML = '<div class="empty-state">Shared recipe was not found or was removed.</div>';
      return;
    }
    renderSharedRecipe(recipe);
  } catch (err) {
    root.innerHTML = `<div class="empty-state">Error loading recipe: ${err.message}</div>`;
  }
}

function renderSharedRecipe(recipe) {
  root.innerHTML = '';
  const card = document.createElement('article');
  card.className = 'detail-card';
  applyDirection(card, recipe.title, recipe.language);

  if (recipe.thumbnailDataUri) {
    const img = document.createElement('img');
    img.src = recipe.thumbnailDataUri;
    img.alt = recipe.title;
    img.className = 'detail-hero-img';
    card.appendChild(img);
  }

  const title = document.createElement('h1');
  title.textContent = recipe.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'chip-row';
  const chips = [
    recipe.category,
    recipe.servings ? `${recipe.servings} servings` : '',
    recipe.prepTimeMinutes ? `Prep ${recipe.prepTimeMinutes}m` : '',
    recipe.cookTimeMinutes ? `Cook ${recipe.cookTimeMinutes}m` : '',
    ...(recipe.dietary || []),
    ...(recipe.tags || []),
  ].filter(Boolean);
  for (const text of chips) {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = text;
    meta.appendChild(span);
  }
  card.appendChild(meta);

  if (recipe.sourceUrl) {
    const link = document.createElement('a');
    link.href = recipe.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'source-link';
    link.textContent = 'View Original Reel / Source';
    card.appendChild(link);
  }

  const ingHeading = document.createElement('h2');
  ingHeading.textContent = recipe.language === 'he' ? 'מצרכים' : 'Ingredients';
  card.appendChild(ingHeading);

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
  card.appendChild(ingList);

  const stepHeading = document.createElement('h2');
  stepHeading.textContent = recipe.language === 'he' ? 'אופן הכנה' : 'Instructions';
  card.appendChild(stepHeading);

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
  card.appendChild(stepList);

  if (recipe.notes) {
    const noteBox = document.createElement('p');
    noteBox.className = 'recipe-notes';
    noteBox.textContent = recipe.notes;
    applyDirection(noteBox, recipe.notes, recipe.language);
    card.appendChild(noteBox);
  }

  root.appendChild(card);
}

if (wakeBtn) {
  wakeBtn.addEventListener('click', async () => {
    const active = wakeBtn.dataset.active === 'true';
    await setWakeLockEnabled(!active, (isOn) => {
      wakeBtn.dataset.active = String(isOn);
      wakeBtn.textContent = isOn ? 'Cook Mode: Screen Awake ON' : 'Keep Screen Awake';
    });
  });
}

init();
