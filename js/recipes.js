/**
 * Firestore recipe CRUD, thumbnail compression, search/filtering, and public read-only shares.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';
import { getFirebaseServices } from './firebase-client.js';

const RECIPES_COLLECTION = 'recipes';
const THUMBNAILS_COLLECTION = 'recipeThumbnails';
const SHARES_COLLECTION = 'sharedRecipes';

/**
 * Compress an uploaded image File/Blob, base64 data URI, or remote image URL into a compact JPEG data URI
 * suitable for Spark-tier Firestore storage without requiring Firebase Storage billing.
 *
 * @param {File | Blob | string} input
 * @param {number} [maxWidth]
 * @param {number} [quality]
 * @returns {Promise<string>}
 */
export function compressImageToDataUri(input, maxWidth = 600, quality = 0.78) {
  return new Promise((resolve, reject) => {
    if (!input) {
      return reject(new Error('No image provided.'));
    }

    const canvasFromImage = (img, fallbackSrc = '') => {
      try {
        const origWidth = img.naturalWidth || img.width || 0;
        const origHeight = img.naturalHeight || img.height || 0;
        if (!origWidth || !origHeight) {
          if (fallbackSrc) return fallbackSrc;
          throw new Error('Image dimensions are 0.');
        }
        const scale = origWidth > maxWidth ? maxWidth / origWidth : 1;
        const width = Math.max(1, Math.round(origWidth * scale));
        const height = Math.max(1, Math.round(origHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        return canvas.toDataURL('image/jpeg', quality);
      } catch (canvasErr) {
        // If canvas is tainted by CORS (or canvas error), fallback to original source
        if (fallbackSrc) {
          return fallbackSrc;
        }
        throw canvasErr;
      }
    };

    // Case 1: File or Blob (from input[type=file], clipboard file, or drag-and-drop)
    if (input instanceof Blob || (input && typeof input.size === 'number')) {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read image file.'));
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const img = new Image();
        // Do NOT set crossOrigin on local data URLs
        img.onerror = () => reject(new Error('Invalid image file format.'));
        img.onload = () => {
          try {
            resolve(canvasFromImage(img, dataUrl));
          } catch (_) {
            resolve(dataUrl);
          }
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(input);
      return;
    }

    // Case 2: String (data URI or web link)
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) {
        return reject(new Error('Image input was empty.'));
      }

      // If already a base64 data URI
      if (trimmed.startsWith('data:image/')) {
        const img = new Image();
        // Do NOT set crossOrigin on data URLs
        img.onerror = () => resolve(trimmed);
        img.onload = () => {
          try {
            resolve(canvasFromImage(img, trimmed));
          } catch (_) {
            resolve(trimmed);
          }
        };
        img.src = trimmed;
        return;
      }

      // If it is an HTTP or HTTPS web link
      if (/^https?:\/\//i.test(trimmed)) {
        // First try to fetch the image as a Blob to bypass canvas origin tainting when CORS is allowed
        if (typeof fetch === 'function') {
          fetch(trimmed, { mode: 'cors' })
            .then((res) => {
              if (res.ok) return res.blob();
              throw new Error(`HTTP ${res.status}`);
            })
            .then((blob) => {
              if (blob && blob.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = String(reader.result);
                  const img = new Image();
                  img.onload = () => {
                    try {
                      resolve(canvasFromImage(img, dataUrl));
                    } catch (_) {
                      resolve(dataUrl);
                    }
                  };
                  img.onerror = () => resolve(trimmed);
                  img.src = dataUrl;
                };
                reader.readAsDataURL(blob);
                return;
              }
              throw new Error('Not an image blob');
            })
            .catch(() => {
              // If fetch fails (CORS restriction), load directly into an Image element without crossOrigin
              const img = new Image();
              img.onerror = () => {
                reject(
                  new Error('Image could not be loaded from this link. Please verify the URL.')
                );
              };
              img.onload = () => {
                try {
                  const dataUri = canvasFromImage(img, trimmed);
                  resolve(dataUri);
                } catch (_) {
                  // Fallback: URL itself will display in <img> preview and library cards
                  resolve(trimmed);
                }
              };
              img.src = trimmed;
            });
          return;
        }

        // Direct Image fallback
        const img = new Image();
        img.onerror = () => reject(new Error('Image could not be loaded from this link.'));
        img.onload = () => {
          try {
            resolve(canvasFromImage(img, trimmed));
          } catch (_) {
            resolve(trimmed);
          }
        };
        img.src = trimmed;
        return;
      }

      return reject(
        new Error('Invalid image format. Expected a file, data URI, or web link (https://...).')
      );
    }

    reject(new Error('Unsupported image input type.'));
  });
}

/**
 * Fetch all recipes owned by the signed-in user along with thumbnails.
 * @param {string} ownerUid
 */
export async function loadUserRecipes(ownerUid) {
  const { db } = getFirebaseServices();
  const q = query(
    collection(db, RECIPES_COLLECTION),
    where('ownerUid', '==', ownerUid)
  );
  const snap = await getDocs(q);
  const recipes = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));

  // Load thumbnails map in parallel (best-effort)
  const thumbSnap = await getDocs(
    query(collection(db, THUMBNAILS_COLLECTION), where('ownerUid', '==', ownerUid))
  );
  const thumbMap = new Map();
  thumbSnap.forEach((docSnap) => {
    thumbMap.set(docSnap.id, docSnap.data().dataUri || '');
  });

  return recipes.map((r) => ({
    ...r,
    source: r.source || (r.sourceUrl ? 'Reel' : (r.tags?.includes('OneNote') ? 'OneNote' : 'Reel')),
    thumbnailDataUri: thumbMap.get(r.id) || r.thumbnailUrl || '',
  }));
}

/**
 * Update all existing user recipes in Firestore that lack a source field to source: 'Reel'.
 * Per user request: all existing recipes in the library are from Reel.
 *
 * @param {string} ownerUid
 * @returns {Promise<number>} Number of migrated recipes
 */
export async function migrateExistingRecipesSource(ownerUid) {
  if (!ownerUid) return 0;
  const { db } = getFirebaseServices();
  const q = query(
    collection(db, RECIPES_COLLECTION),
    where('ownerUid', '==', ownerUid)
  );
  const snap = await getDocs(q);
  let migratedCount = 0;
  const updates = [];
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    if (!data.source) {
      migratedCount += 1;
      updates.push(
        updateDoc(doc(db, RECIPES_COLLECTION, docSnap.id), {
          source: 'Reel',
        }).catch((err) => {
          console.warn(`Failed to migrate source for recipe ${docSnap.id}:`, err);
        })
      );
    }
  });
  if (updates.length > 0) {
    await Promise.all(updates);
  }
  return migratedCount;
}

/**
 * Create or update a recipe document and optional compressed thumbnail.
 */
export async function saveRecipe(ownerUid, recipeData, existingId = null) {
  const { db } = getFirebaseServices();
  const recipeRef = existingId
    ? doc(db, RECIPES_COLLECTION, existingId)
    : doc(collection(db, RECIPES_COLLECTION));

  const thumbnailDataUri = recipeData.thumbnailDataUri || recipeData.thumbnailUrl || '';
  const source = recipeData.source || (recipeData.sourceUrl ? 'Reel' : (recipeData.tags?.includes('OneNote') ? 'OneNote' : 'Manual'));

  const cleanPayload = {
    ownerUid,
    title: (recipeData.title || 'Untitled Recipe').trim(),
    source,
    language: recipeData.language === 'he' ? 'he' : 'en',
    ingredients: Array.isArray(recipeData.ingredients) ? recipeData.ingredients : [],
    steps: Array.isArray(recipeData.steps) ? recipeData.steps : [],
    prepTimeMinutes: recipeData.prepTimeMinutes ?? null,
    cookTimeMinutes: recipeData.cookTimeMinutes ?? null,
    servings: recipeData.servings ?? null,
    category: recipeData.category || 'Other',
    dietary: Array.isArray(recipeData.dietary) ? recipeData.dietary : [],
    tags: Array.isArray(recipeData.tags) ? recipeData.tags : [],
    notes: recipeData.notes || '',
    rating: Number(recipeData.rating || 0),
    sourceUrl: recipeData.sourceUrl || null,
    hasThumbnail: Boolean(thumbnailDataUri),
    updatedAt: serverTimestamp(),
  };

  if (!existingId) {
    cleanPayload.createdAt = serverTimestamp();
    await setDoc(recipeRef, cleanPayload);
  } else {
    await updateDoc(recipeRef, cleanPayload);
  }

  if (thumbnailDataUri && thumbnailDataUri.startsWith('data:image/')) {
    await setDoc(doc(db, THUMBNAILS_COLLECTION, recipeRef.id), {
      ownerUid,
      dataUri: thumbnailDataUri,
      updatedAt: serverTimestamp(),
    });
  } else if (existingId && !thumbnailDataUri) {
    try {
      await deleteDoc(doc(db, THUMBNAILS_COLLECTION, recipeRef.id));
    } catch (_) {
      // Document may not exist in thumbnails collection
    }
  }

  return recipeRef.id;
}

export async function deleteRecipeById(recipeId) {
  const { db } = getFirebaseServices();
  await deleteDoc(doc(db, RECIPES_COLLECTION, recipeId));
  await deleteDoc(doc(db, THUMBNAILS_COLLECTION, recipeId)).catch(() => {});
}

/**
 * Publish a read-only snapshot in sharedRecipes/{shareId} so anyone with the link can view it.
 */
export async function createOrUpdateShareLink(ownerUid, recipe) {
  const { db } = getFirebaseServices();
  const shareId = recipe.shareId || crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  await setDoc(doc(db, SHARES_COLLECTION, shareId), {
    ownerUid,
    recipeId: recipe.id,
    title: recipe.title,
    language: recipe.language || 'en',
    ingredients: recipe.ingredients || [],
    steps: recipe.steps || [],
    prepTimeMinutes: recipe.prepTimeMinutes ?? null,
    cookTimeMinutes: recipe.cookTimeMinutes ?? null,
    servings: recipe.servings ?? null,
    category: recipe.category || 'Other',
    dietary: recipe.dietary || [],
    tags: recipe.tags || [],
    notes: recipe.notes || '',
    sourceUrl: recipe.sourceUrl || null,
    thumbnailDataUri: recipe.thumbnailDataUri || '',
    sharedAt: serverTimestamp(),
  });

  if (!recipe.shareId && recipe.id) {
    await updateDoc(doc(db, RECIPES_COLLECTION, recipe.id), { shareId });
  }
  return shareId;
}

export async function loadSharedRecipe(shareId) {
  const { db } = getFirebaseServices();
  const snap = await getDoc(doc(db, SHARES_COLLECTION, shareId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Filter recipes client-side across title, ingredients, tags, dietary, and language.
 */
export function filterRecipes(recipes, { search = '', category = 'ALL', language = 'ALL', dietary = 'ALL', source = 'ALL' }) {
  const q = search.trim().toLowerCase();
  return recipes.filter((r) => {
    if (category !== 'ALL' && (r.category || 'Other') !== category) return false;
    if (language !== 'ALL' && (r.language || 'en') !== language) return false;
    if (dietary !== 'ALL' && !(r.dietary || []).includes(dietary)) return false;
    if (source !== 'ALL') {
      const rSource = r.source || (r.sourceUrl ? 'Reel' : (r.tags?.includes('OneNote') ? 'OneNote' : 'Manual'));
      if (rSource !== source) return false;
    }
    if (!q) return true;

    const haystack = [
      r.title,
      r.category,
      r.notes,
      ...(r.tags || []),
      ...(r.ingredients || []).map((i) => i.name),
      ...(r.steps || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(q);
  });
}
