/**
 * Firebase v11 modular SDK initialization and auth/Firestore accessors.
 */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';
import { getAppConfig, isFirebaseConfigured } from './config.js?v=3';

let cached = null;

/**
 * Initialize or return the cached Firebase app, auth, and db instances.
 */
export function getFirebaseServices() {
  if (cached) return cached;
  const cfg = getAppConfig();
  if (!isFirebaseConfigured(cfg)) {
    throw new Error('Firebase configuration is missing.');
  }
  const app = getApps().length ? getApps()[0] : initializeApp(cfg.firebase);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const googleProvider = new GoogleAuthProvider();
  cached = { app, auth, db, googleProvider };
  return cached;
}

export async function signInWithGoogle() {
  const { auth, googleProvider } = getFirebaseServices();
  return signInWithPopup(auth, googleProvider);
}

export async function signInWithEmail(email, password) {
  const { auth } = getFirebaseServices();
  return signInWithEmailAndPassword(auth, email, password);
}

export async function registerWithEmail(email, password) {
  const { auth } = getFirebaseServices();
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function logoutUser() {
  const { auth } = getFirebaseServices();
  return signOut(auth);
}

export function subscribeAuth(callback) {
  const { auth } = getFirebaseServices();
  return onAuthStateChanged(auth, callback);
}

export async function getCurrentIdToken() {
  const { auth } = getFirebaseServices();
  const user = auth.currentUser;
  if (!user) throw new Error('Please sign in first.');
  return user.getIdToken();
}
