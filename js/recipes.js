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

    const processImageSource = (src) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onerror = () => {
        // If image failed to load and was a data URI or URL
        if (typeof src === 'string' && src.startsWith('data:image/')) {
          return resolve(src);
        }
        reject(new Error('Invalid image format or image could not be loaded.'));
      };
      img.onload = () => {
        try {
          const scale = img.width > maxWidth ? maxWidth / img.width : 1;
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (canvasErr) {
          // If tainted by CORS, fallback to the original source if it is already a data URI or valid URL
          if (typeof src === 'string') {
            resolve(src);
          } else {
            reject(new Error(`Failed to compress image: ${canvasErr.message}`));
          }
        }
      };
      img.src = src;
    };

    if (typeof input === 'string') {
      processImageSource(input.trim());
    } else if (input instanceof Blob || (input && typeof input.size === 'number')) {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read image file.'));
      reader.onload = () => processImageSource(String(reader.result));
      reader.readAsDataURL(input);
    } else {
      reject(new Error('Unsupported image input type. Expected File, Blob, or URL string.'));
    }
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
