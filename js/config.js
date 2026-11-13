/**
 * Runtime configuration for Firebase (Spark free tier) and the Render extraction API.
 * Fill in DEFAULT_FIREBASE_CONFIG and DEFAULT_API_URL once you create your Firebase project
 * and Render service so every device (PC + phone) loads preconfigured.
 */

const STORAGE_KEY = 'recipe_manager_runtime_config_v1';

export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA72nMPNfsIOeUdJyd_JR4EzKYvZYHY9vI',
  authDomain: 'recipe-manager-7df02.firebaseapp.com',
  projectId: 'recipe-manager-7df02',
  storageBucket: 'recipe-manager-7df02.firebasestorage.app',
  messagingSenderId: '185063642527',
  appId: '1:185063642527:web:85a35a9027207cae0159aa',
};

export const DEFAULT_API_URL = 'https://recipe-manager-api-z9ea.onrender.com';

/**
 * Load merged configuration (defaults overridden by localStorage if present).
 * @returns {{ firebase: typeof DEFAULT_FIREBASE_CONFIG, apiUrl: string }}
 */
export function getAppConfig() {
  let saved = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    saved = null;
  }

  const firebase = {
    ...DEFAULT_FIREBASE_CONFIG,
    ...(saved?.firebase || {}),
  };
  const apiUrl = String(saved?.apiUrl || DEFAULT_API_URL || '').replace(/\/+$/, '');
  return { firebase, apiUrl };
}

/**
 * Persist configuration overrides into localStorage.
 * @param {{ firebase?: Partial<typeof DEFAULT_FIREBASE_CONFIG>, apiUrl?: string }} next
 */
export function saveAppConfig(next) {
  const current = getAppConfig();
  const merged = {
    firebase: { ...current.firebase, ...(next.firebase || {}) },
    apiUrl: String(next.apiUrl ?? current.apiUrl).replace(/\/+$/, ''),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Return true when minimum required Firebase Web SDK fields are populated.
 */
export function isFirebaseConfigured(cfg = getAppConfig()) {
  return Boolean(cfg.firebase.apiKey && cfg.firebase.projectId && cfg.firebase.authDomain);
}
