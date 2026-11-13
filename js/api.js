/**
 * Client for the Render Python FastAPI extraction & translation service with verbose diagnostics.
 */

import { getAppConfig } from './config.js?v=4';
import { getCurrentIdToken } from './firebase-client.js?v=4';

const apiLogs = [];
let logListener = null;

export function subscribeApiLogs(fn) {
  logListener = fn;
}

export function logApi(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  apiLogs.push(line);
  if (apiLogs.length > 100) apiLogs.shift();
  if (logListener) logListener(line, apiLogs.join('\n'));
}

export function getApiLogHistory() {
  return apiLogs.join('\n');
}

function resolveApiUrl() {
  const { apiUrl } = getAppConfig();
  if (!apiUrl) {
    throw new Error('Backend API URL is not configured. Check js/config.js or Settings.');
  }
  return apiUrl;
}

async function authedJsonFetch(path, body, onStatus = null) {
  const baseUrl = resolveApiUrl();
  const token = await getCurrentIdToken();
  const fullUrl = `${baseUrl}${path}`;

  logApi(`POST -> ${fullUrl}`);
  logApi(`Payload: ${JSON.stringify(body).slice(0, 150)}...`);

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 95000); // 95s timeout for video processing
    response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (netErr) {
    const isTimeout = netErr.name === 'AbortError';
    const detailMsg = isTimeout
      ? 'Request timed out after 95s. Video downloading/transcription took too long.'
      : `Network error (${netErr.name}: ${netErr.message}). Check internet or Render backend health.`;
    logApi(`FETCH ERROR: ${detailMsg}`);
    throw new Error(detailMsg);
  }

  logApi(`Response: HTTP ${response.status} ${response.statusText}`);
  const rawText = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = { rawText };
  }

  if (!response.ok) {
    const errorMsg = payload.detail || payload.message || payload.rawText || response.statusText;
    const formatted = `API Error [HTTP ${response.status}]: ${typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : errorMsg}`;
    logApi(`ERROR: ${formatted}`);
    throw new Error(formatted);
  }

  logApi(`Success from ${path} (status=${payload.status || 'ok'})`);
  return payload;
}

/**
 * Ping /health to wake up a sleeping Render free-tier instance with a retry loop.
 */
export async function wakeBackend(onStatus) {
  const baseUrl = resolveApiUrl();
  const healthUrl = `${baseUrl}/health`;
  logApi(`Checking backend health at ${healthUrl}...`);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      if (onStatus) {
        onStatus(
          attempt === 1
            ? 'Checking extraction server...'
            : `Waking Render free tier (attempt ${attempt}/4, can take ~30s)...`
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 18000);
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) {
        logApi(`Backend healthy on attempt ${attempt}: HTTP ${response.status}`);
        if (onStatus) onStatus('Extraction server ready.');
        return true;
      }
      logApi(`Health ping attempt ${attempt} returned HTTP ${response.status}`);
    } catch (err) {
      logApi(`Health ping attempt ${attempt} failed: ${err.name} - ${err.message}`);
    }
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }

  logApi('Warning: health check did not respond affirmatively within retry limit; proceeding with request.');
  return false;
}

export async function extractReel(url, extraContext = '', onStatus = null) {
  return authedJsonFetch('/api/extract-reel', { url, extraContext }, onStatus);
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

  logApi(`POST OneNote file: ${file.name} (${file.size} bytes)`);
  const response = await fetch(`${baseUrl}/api/parse-onenote`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const rawText = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = { rawText };
  }

  if (!response.ok) {
    const errorMsg = payload.detail || payload.rawText || response.statusText;
    const formatted = `OneNote API Error [HTTP ${response.status}]: ${typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : errorMsg}`;
    logApi(formatted);
    throw new Error(formatted);
  }
  return payload;
}
