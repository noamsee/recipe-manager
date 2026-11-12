/**
 * Client for the Render Python FastAPI extraction & translation service.
 */

import { getAppConfig } from './config.js';
import { getCurrentIdToken } from './firebase-client.js';

function resolveApiUrl() {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new Error('Backend API URL is not configured. Add your Render URL in Settings.');
  }
  return apiUrl;
}

async function authedJsonFetch(path, body) {
  const baseUrl = resolveApiUrl();
  const token = await getCurrentIdToken();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `Request failed (${response.status})`);
  }
  return payload;
}

/**
 * Ping /health to wake up a sleeping Render free-tier instance.
 */
export async function wakeBackend(onStatus) {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) return false;
  if (onStatus) onStatus('Waking extraction server (Render free tier can take ~30s)...');
  const response = await fetch(`${apiUrl}/health`, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status})`);
  }
  if (onStatus) onStatus('Extraction server ready.');
  return true;
}

export async function extractReel(url, extraContext = '') {
  return authedJsonFetch('/api/extract-reel', { url, extraContext });
}

export async function parseRecipeText(text, sourceUrl = null) {
  return authedJsonFetch('/api/parse-text', { text, sourceUrl });
}

export async function translateRecipe(recipe, targetLanguage) {
  return authedJsonFetch('/api/translate', { recipe, targetLanguage });
}

export async function parseOneNoteFile(file) {
  const baseUrl = resolveApiUrl();
  const token = await getCurrentIdToken();
  const form = new FormData();
  form.append('file', file);

  const response = await fetch(`${baseUrl}/api/parse-onenote`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `OneNote upload failed (${response.status})`);
  }
  return payload;
}
