/**
 * Firestore-backed supermarket shopping list management.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';
import { getFirebaseServices } from './firebase-client.js';

const SHOPPING_COLLECTION = 'shoppingList';

export async function loadShoppingList(ownerUid) {
  const { db } = getFirebaseServices();
  const q = query(collection(db, SHOPPING_COLLECTION), where('ownerUid', '==', ownerUid));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      if (Boolean(a.checked) !== Boolean(b.checked)) return a.checked ? 1 : -1;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });
}

export async function addShoppingItems(ownerUid, items, recipeTitle = '') {
  const { db } = getFirebaseServices();
  const batch = writeBatch(db);
  for (const item of items) {
    const text = typeof item === 'string'
      ? item.trim()
      : [item.amount, item.unit, item.name].filter(Boolean).join(' ').trim();
    if (!text) continue;
    const ref = doc(collection(db, SHOPPING_COLLECTION));
    batch.set(ref, {
      ownerUid,
      text,
      recipeTitle,
      checked: false,
      createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

export async function addSingleShoppingItem(ownerUid, text) {
  const cleaned = text.trim();
  if (!cleaned) return;
  const { db } = getFirebaseServices();
  const ref = doc(collection(db, SHOPPING_COLLECTION));
  await setDoc(ref, {
    ownerUid,
    text: cleaned,
    recipeTitle: '',
    checked: false,
    createdAt: serverTimestamp(),
  });
}

export async function toggleShoppingItem(itemId, checked) {
  const { db } = getFirebaseServices();
  await updateDoc(doc(db, SHOPPING_COLLECTION, itemId), { checked: Boolean(checked) });
}

export async function removeShoppingItem(itemId) {
  const { db } = getFirebaseServices();
  await deleteDoc(doc(db, SHOPPING_COLLECTION, itemId));
}

export async function clearCheckedShoppingItems(items) {
  const { db } = getFirebaseServices();
  const checkedItems = items.filter((i) => i.checked);
  if (!checkedItems.length) return;
  const batch = writeBatch(db);
  for (const item of checkedItems) {
    batch.delete(doc(db, SHOPPING_COLLECTION, item.id));
  }
  await batch.commit();
}
