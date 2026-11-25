/**
 * Client-side ZIP archive importer for Recipe Manager.
 * Validates zip format, parses recipes.json, extracts embedded images, and structures Hebrew/English recipes.
 */

function getJSZip() {
  if (typeof window !== 'undefined' && window.JSZip) {
    return window.JSZip;
  }
  if (typeof globalThis !== 'undefined' && globalThis.JSZip) {
    return globalThis.JSZip;
  }
  throw new Error('JSZip library is not loaded. Please ensure jszip.min.js is included.');
}

/**
 * Intelligent parser for unstructured Hebrew & English recipe text (e.g. from OneNote exports).
 * Extracts title, servings, ingredients (with groups), steps, notes, and source URL.
 *
 * @param {string} text
 * @param {string} [defaultTitle]
 * @param {string} [defaultCategory]
 * @returns {Object}
 */
export function parseRecipeText(text = '', defaultTitle = '', defaultCategory = 'Other') {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let title = defaultTitle;
  let servings = null;
  let sourceUrl = null;
  const ingredients = [];
  let steps = [];
  let notesList = [];

  let currentSection = 'intro';
  let currentGroup = '';

  const ingHeaders = /^(מרכיבים|המרכיבים|רכיבים|מצרכים|חומרים|מצרכים\s*ל|מרכיבים\s*ל|רכיבים\s*ל|ingredients)/i;
  const stepHeaders = /^(אופן ההכנה|הוראות הכנה|הכנה|הוראות|אופן הכנה|שלבי הכנה|מתחילים עם|instructions|preparation|directions)/i;
  const notesHeaders = /^(טיפים|טיפים ושדרוגים|הערות|הערות והארות|גיוונים|הערות חשובות|tips|notes)/i;
  const servingsRe = /(?:כ|-|\b)?(\d+)\s*[-–]?\s*מנות|מנות\s*:\s*(\d+)/i;
  const urlRe = /From\s*<([^>]+)>|https?:\/\/[^\s<>]+/i;

  const urlMatch = urlRe.exec(text);
  if (urlMatch) {
    sourceUrl = urlMatch[1] || urlMatch[0];
  }

  for (const line of lines) {
    if (line.startsWith('From <') || line.startsWith('>From <')) {
      continue;
    }
    // Skip date/time lines (e.g. 'Tuesday, November 17, 2015', '4:03 PM')
    if (
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(line) ||
      /^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(line)
    ) {
      continue;
    }

    const mServ = servingsRe.exec(line);
    if (mServ) {
      const val = parseInt(mServ[1] || mServ[2], 10);
      if (!Number.isNaN(val)) servings = val;
      // If the line is primarily a servings count (e.g. "כ 10-מנות"), don't add as ingredient
      if (line.replace(servingsRe, '').replace(/^[•\-\*\s]+/, '').trim().length < 5) {
        continue;
      }
    }

    // Check section header changes
    if (ingHeaders.test(line) && !stepHeaders.test(line)) {
      currentSection = 'ingredients';
      if (line.includes(':')) {
        const afterCol = line.split(':', 1)[0].trim();
        if (['לרוטב', 'לבצק', 'למילוי', 'לסלט', 'למרק'].some((w) => afterCol.includes(w))) {
          currentGroup = afterCol;
        }
      }
      continue;
    } else if (stepHeaders.test(line)) {
      currentSection = 'steps';
      continue;
    } else if (notesHeaders.test(line)) {
      currentSection = 'notes';
      continue;
    }

    // Skip lone numbered bullets like '.1', '.2'
    if (/^\.?\d+\.?$/.test(line)) {
      continue;
    }

    if (currentSection === 'intro') {
      if (
        line.endsWith(':') &&
        line.length < 30 &&
        ['רוטב', 'סלט', 'בצק', 'מילוי', 'מרינדה', 'הגשה', 'רביכה'].some((w) => line.includes(w))
      ) {
        currentSection = 'ingredients';
        currentGroup = line.slice(0, -1).trim();
        continue;
      }
      if (
        /^[•\-\*]\s*/.test(line) ||
        ['כוס', 'כפות', 'כפית', 'גרם', 'קג', 'שיני שום', 'צרור', 'קופסת', 'גזרים', 'תפוחי אדמה'].some((u) =>
          line.includes(u)
        )
      ) {
        currentSection = 'ingredients';
        const cleaned = line.replace(/^[•\-\*]\s*/, '').trim();
        ingredients.push({ name: cleaned, group: currentGroup, amount: '', unit: '' });
        continue;
      }
      if (!title && line.length < 80) {
        title = line;
      } else {
        notesList.push(line);
      }
    } else if (currentSection === 'ingredients') {
      if (
        /^\.?\d+[\.\)]\s*[א-ת]/.test(line) ||
        ['מחממים תנור', 'מחממים שמן', 'בסיר גדול', 'בקערה גדולה', 'חותכים את', 'מערבבים את', 'מניחים את', 'אופים ב'].some(
          (v) => line.startsWith(v)
        )
      ) {
        currentSection = 'steps';
        const cleaned = line.replace(/^\.?\d+[\.\)]\s*/, '').trim();
        steps.push(cleaned);
        continue;
      }
      if (line.endsWith(':') && line.length < 30) {
        currentGroup = line.slice(0, -1).trim();
        continue;
      }
      const cleaned = line.replace(/^[•\-\*]\s*/, '').trim();
      if (cleaned) {
        ingredients.push({ name: cleaned, group: currentGroup, amount: '', unit: '' });
      }
    } else if (currentSection === 'steps') {
      const cleaned = line.replace(/^\.?\d+[\.\)]\s*/, '').trim();
      if (cleaned) {
        steps.push(cleaned);
      }
    } else if (currentSection === 'notes') {
      const cleaned = line.replace(/^[•\-\*]\s*/, '').trim();
      if (cleaned) {
        notesList.push(cleaned);
      }
    }
  }

  // Fallback if no steps were identified
  if (steps.length === 0) {
    if (notesList.length > 0) {
      steps = [notesList[notesList.length - 1]];
      notesList = notesList.slice(0, -1);
    } else {
      steps = ['מערבבים את כל המרכיבים ומגישים לפי הטעם.'];
    }
  }

  return {
    title: title || defaultTitle,
    category: defaultCategory,
    servings,
    ingredients,
    steps,
    notes: notesList.join('\n'),
    sourceUrl,
  };
}

/**
 * Step 1 verification: Validate that the uploaded file is a valid ZIP archive
 * containing "recipes.json" with proper recipe records.
 *
 * @param {Blob | File | ArrayBuffer | Uint8Array} fileData
 * @returns {Promise<{ valid: boolean, error?: string, recipesRaw?: Array, imageCount?: number, zipInstance?: any, message?: string }>}
 */
export async function validateZipArchive(fileData) {
  const JSZip = getJSZip();

  let zip;
  try {
    zip = await JSZip.loadAsync(fileData);
  } catch (err) {
    return {
      valid: false,
      error: `Invalid file: The selected file is not a valid ZIP archive (${err.message}).`,
    };
  }

  // Find recipes.json (check root and any immediate subdirectories)
  const fileNames = Object.keys(zip.files);
  let jsonFileName = fileNames.find((name) => /(^|\/)recipes\.json$/i.test(name));
  if (!jsonFileName) {
    // If not named recipes.json, check if there's any single .json file with recipe data
    jsonFileName = fileNames.find((name) => /\.json$/i.test(name) && !name.includes('__MACOSX'));
  }

  if (!jsonFileName) {
    return {
      valid: false,
      error:
        'Wrong format: The ZIP archive must contain a "recipes.json" file with recipe records and an optional "images/" folder.',
    };
  }

  // Read and parse recipes.json
  let rawJsonText;
  try {
    rawJsonText = await zip.file(jsonFileName).async('string');
  } catch (err) {
    return {
      valid: false,
      error: `Failed to read "${jsonFileName}" from zip archive: ${err.message}`,
    };
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawJsonText);
  } catch (err) {
    return {
      valid: false,
      error: `Wrong format: "${jsonFileName}" is not valid JSON (${err.message}).`,
    };
  }

  // Must be an array of recipes or an object containing a recipes array
  let recipesList = Array.isArray(parsedJson) ? parsedJson : parsedJson.recipes;
  if (!Array.isArray(recipesList) || recipesList.length === 0) {
    return {
      valid: false,
      error:
        'Wrong format: "recipes.json" does not contain any recipe entries. Expected a JSON array of recipes.',
    };
  }

  // Validate recipe records have titles
  const validRecords = recipesList.filter((r) => r && typeof r === 'object' && (r.title || r.name));
  if (validRecords.length === 0) {
    return {
      valid: false,
      error:
        'Wrong format: Recipes in "recipes.json" are missing a required "title" property.',
    };
  }

  // Count available images
  const imageCount = fileNames.filter(
    (name) => /\.(jpe?g|png|webp|gif)$/i.test(name) && !name.includes('__MACOSX')
  ).length;

  return {
    valid: true,
    recipesRaw: validRecords,
    imageCount,
    zipInstance: zip,
    message: `Format verified successfully: Found ${validRecords.length} recipes and ${imageCount} images in archive.`,
  };
}

/**
 * Step 2: Extract, structure, and attach images to all recipes from the verified zip.
 *
 * @param {Blob | File | ArrayBuffer} fileData
 * @param {Function} [onProgress]
 * @returns {Promise<{ recipes: Array<Object>, total: number, imageCount: number }>}
 */
export async function extractRecipesFromZip(fileData, onProgress = null) {
  const validation = await validateZipArchive(fileData);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { zipInstance: zip, recipesRaw, imageCount } = validation;

  // Build image map (normalized relative paths -> zip file entry)
  const imageFiles = new Map();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir && /\.(jpe?g|png|webp|gif)$/i.test(name) && !name.includes('__MACOSX')) {
      const normName = name.replace(/\\/g, '/');
      imageFiles.set(normName, entry);
      const baseName = normName.split('/').pop();
      if (baseName) imageFiles.set(baseName, entry);
    }
  }

  const recipes = [];

  for (let i = 0; i < recipesRaw.length; i += 1) {
    const raw = recipesRaw[i];
    const rawTitle = (raw.title || raw.name || `Recipe ${i + 1}`).trim();
    const rawCategory = (raw.category || 'Other').trim();

    // 1. Extract and compress primary thumbnail image
    let thumbnailDataUri = '';
    const imgCandidates = [
      ...(Array.isArray(raw.images) ? raw.images : []),
      raw.thumbnailUrl,
      raw.thumbnailDataUri,
      raw.image,
    ].filter(Boolean);

    for (const ref of imgCandidates) {
      if (typeof ref === 'string') {
        if (ref.startsWith('data:image/')) {
          thumbnailDataUri = ref;
          break;
        }
        const normRef = ref.replace(/\\/g, '/');
        const baseRef = normRef.split('/').pop();
        const zipImg = imageFiles.get(normRef) || imageFiles.get(baseRef);
        if (zipImg) {
          try {
            const b64 = await zipImg.async('base64');
            const mime = /\.(png)$/i.test(normRef) ? 'image/png' : 'image/jpeg';
            thumbnailDataUri = `data:${mime};base64,${b64}`;
            break;
          } catch (_) {}
        }
      }
    }

    // 2. Structured ingredients and steps
    let parsedIngredients = [];
    let parsedSteps = [];
    let parsedServings = raw.servings ? Number(raw.servings) : null;
    let parsedNotes = raw.notes || '';
    let parsedSourceUrl = raw.sourceUrl || raw.source_pdf || null;

    if (Array.isArray(raw.ingredients) && raw.ingredients.length > 0) {
      parsedIngredients = raw.ingredients.map((ing) => {
        if (typeof ing === 'string') {
          return { name: ing, amount: '', unit: '', group: '' };
        }
        return {
          name: ing.name || '',
          amount: ing.amount || '',
          unit: ing.unit || '',
          group: ing.group || '',
        };
      });
      parsedSteps = Array.isArray(raw.steps) ? raw.steps : [];
    } else if (raw.text) {
      const parsedText = parseRecipeText(raw.text, rawTitle, rawCategory);
      parsedIngredients = parsedText.ingredients;
      parsedSteps = parsedText.steps;
      if (!parsedServings && parsedText.servings) parsedServings = parsedText.servings;
      if (!parsedNotes && parsedText.notes) parsedNotes = parsedText.notes;
      if (!parsedSourceUrl && parsedText.sourceUrl) parsedSourceUrl = parsedText.sourceUrl;
    }

    // 3. Language detection
    const fullTextForLang = `${rawTitle} ${parsedIngredients.map((i) => i.name).join(' ')}`;
    const hebrewCharCount = (fullTextForLang.match(/[\u0590-\u05ff]/g) || []).length;
    const language = hebrewCharCount >= 5 ? 'he' : 'en';

    const recipe = {
      title: rawTitle,
      category: rawCategory,
      source: 'OneNote (PDF)',
      language,
      servings: parsedServings,
      prepTimeMinutes: raw.prepTimeMinutes ? Number(raw.prepTimeMinutes) : null,
      cookTimeMinutes: raw.cookTimeMinutes ? Number(raw.cookTimeMinutes) : null,
      ingredients: parsedIngredients,
      steps: parsedSteps,
      notes: parsedNotes,
      sourceUrl: parsedSourceUrl,
      tags: Array.from(new Set(['OneNote', rawCategory, ...(raw.tags || [])])).filter(Boolean),
      dietary: Array.isArray(raw.dietary) ? raw.dietary : [],
      thumbnailDataUri,
      hasThumbnail: Boolean(thumbnailDataUri),
    };

    recipes.push(recipe);

    if (onProgress) {
      onProgress({
        index: i + 1,
        total: recipesRaw.length,
        recipe,
      });
    }
  }

  return {
    recipes,
    total: recipes.length,
    imageCount,
  };
}
