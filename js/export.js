/**
 * Export recipes to portable JSON and Markdown backups.
 */

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
