/**
 * Export recipes to portable PDF, Markdown, and JSON backups.
 * Includes photo rendering, category/tag filtering, and bilingual RTL/LTR print layouts.
 */

/**
 * Filter a list of recipes by category, dietary label, custom tag, and/or language.
 *
 * @param {Array<Object>} recipes
 * @param {{ category?: string, dietary?: string, tag?: string, language?: string }} filters
 * @returns {Array<Object>}
 */
export function filterRecipesForExport(recipes = [], filters = {}) {
  const { category = 'ALL', dietary = 'ALL', tag = 'ALL', language = 'ALL' } = filters;

  return recipes.filter((r) => {
    if (!r) return false;

    // Filter by category / section
    if (category && category !== 'ALL') {
      const rCat = (r.category || 'Other').trim().toLowerCase();
      if (rCat !== category.trim().toLowerCase()) return false;
    }

    // Filter by dietary tag
    if (dietary && dietary !== 'ALL') {
      const rDietary = Array.isArray(r.dietary) ? r.dietary : [];
      if (!rDietary.includes(dietary.toLowerCase())) return false;
    }

    // Filter by custom tag
    if (tag && tag !== 'ALL') {
      const rTags = Array.isArray(r.tags) ? r.tags : [];
      const matchTag = rTags.some((t) => t.trim().toLowerCase() === tag.trim().toLowerCase());
      if (!matchTag) return false;
    }

    // Filter by language
    if (language && language !== 'ALL') {
      if ((r.language || 'en') !== language) return false;
    }

    return true;
  });
}

/**
 * Serialize recipes array to formatted JSON string.
 * @param {Array<object>} recipes
 * @returns {string}
 */
export function recipesToJson(recipes) {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: recipes.length,
      recipes,
    },
    null,
    2
  );
}

/**
 * Format recipes array as a single human-readable Markdown document.
 * @param {Array<object>} recipes
 * @returns {string}
 */
export function recipesToMarkdown(recipes) {
  const sections = recipes.map((r) => {
    const lines = [`# ${r.title || 'Untitled Recipe'}`];
    const meta = [];
    if (r.category) meta.push(`Category: ${r.category}`);
    if (r.language) meta.push(`Language: ${r.language}`);
    if (r.servings) meta.push(`Servings: ${r.servings}`);
    if (r.prepTimeMinutes) meta.push(`Prep: ${r.prepTimeMinutes}m`);
    if (r.cookTimeMinutes) meta.push(`Cook: ${r.cookTimeMinutes}m`);
    if (r.rating) meta.push(`Rating: ${r.rating}/5`);
    if (meta.length) lines.push(meta.join(' | '));
    if (Array.isArray(r.dietary) && r.dietary.length) lines.push(`Dietary: ${r.dietary.join(', ')}`);
    if (Array.isArray(r.tags) && r.tags.length) lines.push(`Tags: ${r.tags.join(', ')}`);
    if (r.sourceUrl) lines.push(`Source: ${r.sourceUrl}`);

    lines.push('', '## Ingredients');
    for (const ing of r.ingredients || []) {
      const qty = [ing.amount, ing.unit].filter(Boolean).join(' ');
      const prefix = ing.group ? `[${ing.group}] ` : '';
      lines.push(`- ${prefix}${qty ? `${qty} ` : ''}${ing.name}`);
    }

    lines.push('', '## Steps');
    (r.steps || []).forEach((step, idx) => {
      lines.push(`${idx + 1}. ${step}`);
    });

    if (r.notes) {
      lines.push('', '## Notes', r.notes);
    }
    return lines.join('\n');
  });

  return sections.join('\n\n---\n\n');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate a complete, standalone, print-optimized HTML cookbook document.
 * Includes embedded photos, bilingual RTL/LTR typography, and clean page breaks.
 *
 * @param {Array<Object>} recipes
 * @param {Object} [options]
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @returns {string}
 */
export function generateCookbookHtml(recipes, options = {}) {
  const docTitle = options.title || 'Recipe Manager Cookbook';
  const subtitle = options.subtitle || `Exported ${new Date().toLocaleDateString()} • ${recipes.length} Recipe(s)`;

  // Table of contents entries
  const tocEntries = recipes
    .map(
      (r, idx) => `
      <li class="toc-item">
        <span class="toc-title">${escapeHtml(r.title || 'Untitled')}</span>
        <span class="toc-category">${escapeHtml(r.category || 'Other')}</span>
      </li>
    `
    )
    .join('');

  // Individual recipe cards
  const recipePages = recipes
    .map((r, idx) => {
      const isHe = r.language === 'he';
      const dir = isHe ? 'rtl' : 'ltr';
      const lang = isHe ? 'he' : 'en';

      const thumb = r.thumbnailDataUri || r.thumbnailUrl || '';
      const photoHtml = thumb
        ? `<div class="recipe-photo-box"><img src="${thumb}" alt="${escapeHtml(r.title)}" class="recipe-photo" /></div>`
        : '';

      const metaChips = [];
      if (r.category) metaChips.push(`<span class="chip">${escapeHtml(r.category)}</span>`);
      if (r.servings) metaChips.push(`<span class="chip">${isHe ? 'מנות' : 'Servings'}: ${r.servings}</span>`);
      if (r.prepTimeMinutes) metaChips.push(`<span class="chip">${isHe ? 'הכנה' : 'Prep'}: ${r.prepTimeMinutes}m</span>`);
      if (r.cookTimeMinutes) metaChips.push(`<span class="chip">${isHe ? 'בישול' : 'Cook'}: ${r.cookTimeMinutes}m</span>`);
      if (Array.isArray(r.dietary)) {
        r.dietary.forEach((d) => metaChips.push(`<span class="chip chip-dietary">${escapeHtml(d)}</span>`));
      }
      if (Array.isArray(r.tags)) {
        r.tags.forEach((t) => metaChips.push(`<span class="chip chip-tag">#${escapeHtml(t)}</span>`));
      }

      const ingItems = (r.ingredients || [])
        .map((ing) => {
          const qty = [ing.amount, ing.unit].filter(Boolean).join(' ');
          const grp = ing.group ? `<span class="ing-group">[${escapeHtml(ing.group)}] </span>` : '';
          return `<li>${grp}<strong>${escapeHtml(qty)}</strong> ${escapeHtml(ing.name)}</li>`;
        })
        .join('');

      const stepItems = (r.steps || [])
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join('');

      return `
      <article class="recipe-page" dir="${dir}" lang="${lang}">
        <header class="recipe-header">
          <h2 class="recipe-title">${escapeHtml(r.title || 'Untitled')}</h2>
          <div class="meta-row">${metaChips.join(' ')}</div>
        </header>

        ${photoHtml}

        <div class="recipe-content-grid">
          <div class="ingredients-box">
            <h3>${isHe ? 'מצרכים' : 'Ingredients'}</h3>
            <ul class="ingredients-list">${ingItems || '<li>-</li>'}</ul>
          </div>
          <div class="steps-box">
            <h3>${isHe ? 'הוראות הכנה' : 'Instructions'}</h3>
            <ol class="steps-list">${stepItems || '<li>-</li>'}</ol>
          </div>
        </div>

        ${r.notes ? `
          <div class="notes-box">
            <h4>${isHe ? 'הערות אישיות' : 'Notes'}</h4>
            <p>${escapeHtml(r.notes)}</p>
          </div>
        ` : ''}

        ${r.sourceUrl ? `
          <footer class="recipe-source">
            <small>${isHe ? 'מקור' : 'Source'}: <a href="${escapeHtml(r.sourceUrl)}">${escapeHtml(r.sourceUrl)}</a></small>
          </footer>
        ` : ''}
      </article>
    `;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(docTitle)}</title>
  <style>
    @page {
      size: A4;
      margin: 1.5cm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      background: #f8fafc;
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }
    
    /* Top banner for preview mode (hidden during print) */
    .screen-toolbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: #c2410c;
      color: #fff;
      padding: 0.75rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .screen-toolbar button {
      background: #fff;
      color: #c2410c;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.95rem;
    }
    .screen-toolbar button:hover {
      background: #fff7ed;
    }
    
    .cookbook-container {
      max-width: 820px;
      margin: 2rem auto;
      background: #fff;
      padding: 2.5rem;
      box-shadow: 0 4px 16px rgba(0,0,0,0.06);
      border-radius: 8px;
    }

    /* Cover / Table of Contents */
    .cookbook-cover {
      text-align: center;
      padding: 3rem 1rem 2rem 1rem;
      border-bottom: 2px solid #e2e8f0;
      margin-bottom: 2rem;
    }
    .cookbook-cover h1 {
      color: #c2410c;
      font-size: 2.4rem;
      margin: 0 0 0.5rem 0;
    }
    .cookbook-cover p {
      color: #64748b;
      font-size: 1.1rem;
      margin: 0 0 2rem 0;
    }
    .toc-card {
      text-align: left;
      background: #fdfaf7;
      border: 1px solid #fed7aa;
      border-radius: 8px;
      padding: 1.25rem;
      margin-top: 1.5rem;
    }
    .toc-card h3 {
      margin-top: 0;
      color: #9a3412;
      border-bottom: 1px solid #fed7aa;
      padding-bottom: 0.5rem;
    }
    .toc-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 0.5rem;
    }
    .toc-item {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.9rem;
    }
    .toc-title { font-weight: 600; color: #1e293b; }
    .toc-category { color: #64748b; font-size: 0.8rem; }

    /* Recipe Page */
    .recipe-page {
      padding: 1.5rem 0;
      page-break-after: always;
      break-after: page;
    }
    .recipe-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }

    .recipe-header {
      margin-bottom: 1rem;
    }
    .recipe-title {
      font-size: 1.8rem;
      color: #c2410c;
      margin: 0 0 0.5rem 0;
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-bottom: 1rem;
    }
    .chip {
      background: #f1f5f9;
      color: #334155;
      font-size: 0.8rem;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      font-weight: 500;
    }
    .chip-dietary {
      background: #dcfce7;
      color: #166534;
    }
    .chip-tag {
      background: #e0e7ff;
      color: #3730a3;
    }

    .recipe-photo-box {
      text-align: center;
      margin: 1rem 0 1.5rem 0;
    }
    .recipe-photo {
      max-width: 100%;
      max-height: 320px;
      object-fit: cover;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    .recipe-content-grid {
      display: grid;
      grid-template-columns: 1fr 1.6fr;
      gap: 1.75rem;
      margin-top: 1rem;
    }
    [dir="rtl"] .recipe-content-grid {
      grid-template-columns: 1.6fr 1fr;
    }

    h3 {
      font-size: 1.2rem;
      color: #0f172a;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 0.35rem;
      margin-top: 0;
    }

    .ingredients-list {
      list-style-type: square;
      padding-inline-start: 1.2rem;
      margin: 0;
    }
    .ingredients-list li {
      margin-bottom: 0.4rem;
      font-size: 0.95rem;
    }

    .steps-list {
      padding-inline-start: 1.4rem;
      margin: 0;
    }
    .steps-list li {
      margin-bottom: 0.65rem;
      font-size: 0.95rem;
      line-height: 1.55;
    }

    .notes-box {
      margin-top: 1.5rem;
      background: #fffbeb;
      border-inline-start: 4px solid #f59e0b;
      padding: 0.75rem 1rem;
      border-radius: 0 6px 6px 0;
    }
    [dir="rtl"] .notes-box {
      border-radius: 6px 0 0 6px;
    }
    .notes-box h4 {
      margin: 0 0 0.3rem 0;
      color: #b45309;
      font-size: 0.95rem;
    }
    .notes-box p {
      margin: 0;
      font-size: 0.9rem;
      color: #78350f;
    }

    .recipe-source {
      margin-top: 1.25rem;
      padding-top: 0.5rem;
      border-top: 1px dashed #cbd5e1;
      color: #94a3b8;
    }
    .recipe-source a {
      color: #64748b;
      word-break: break-all;
    }

    /* Print styles */
    @media print {
      body {
        background: #fff !important;
      }
      .screen-toolbar {
        display: none !important;
      }
      .cookbook-container {
        max-width: none !important;
        margin: 0 !important;
        padding: 0 !important;
        box-shadow: none !important;
      }
      .recipe-page {
        page-break-after: always !important;
        break-after: page !important;
      }
      .recipe-page:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }
    }
  </style>
</head>
<body>
  <div class="screen-toolbar">
    <div>
      <strong>${escapeHtml(docTitle)}</strong> &bull;
      <span>${recipes.length} recipe(s) ready to print/save</span>
    </div>
    <div style="display: flex; gap: 0.5rem; align-items: center;">
      <button onclick="window.print()">🖨️ Save as PDF / Print</button>
      <button onclick="window.close()" style="background: rgba(255,255,255,0.2); color: #fff;">Close</button>
    </div>
  </div>

  <main class="cookbook-container">
    ${
      recipes.length > 1
        ? `
      <section class="cookbook-cover">
        <h1>${escapeHtml(docTitle)}</h1>
        <p>${escapeHtml(subtitle)}</p>
        <div class="toc-card">
          <h3>Table of Contents (${recipes.length})</h3>
          <ul class="toc-list">${tocEntries}</ul>
        </div>
      </section>
    `
        : ''
    }

    ${recipePages}
  </main>
</body>
</html>`;
}

/**
 * Open a formatted printable cookbook in a new window and prompt print/save as PDF.
 *
 * @param {Array<Object>} recipes
 * @param {Object} [options]
 */
export function exportRecipesToPdf(recipes, options = {}) {
  if (!recipes || recipes.length === 0) {
    throw new Error('No recipes available to export.');
  }

  const html = generateCookbookHtml(recipes, options);
  const printWin = window.open('', '_blank');
  if (!printWin) {
    throw new Error('Popup blocked. Please allow popups to export the PDF cookbook.');
  }

  printWin.document.open();
  printWin.document.write(html);
  printWin.document.close();

  // Trigger print once document has parsed
  setTimeout(() => {
    printWin.focus();
    printWin.print();
  }, 500);
}

/**
 * Trigger a browser download for a text payload.
 * @param {string} filename
 * @param {string} content
 * @param {string} mimeType
 */
export function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
