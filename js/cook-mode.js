/**
 * Cook Mode helpers: Screen Wake Lock API + checkable recipe progress.
 */

let wakeLockSentinel = null;

export function isWakeLockSupported() {
  return 'wakeLock' in navigator;
}

export async function setWakeLockEnabled(enabled, onChange) {
  if (!isWakeLockSupported()) {
    if (onChange) onChange(false, 'Wake Lock not supported in this browser.');
    return false;
  }

  if (enabled) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
        if (onChange) onChange(false, 'Screen wake lock released.');
      });
      if (onChange) onChange(true, 'Screen will stay awake while cooking.');
      return true;
    } catch (err) {
      if (onChange) onChange(false, `Could not enable Wake Lock: ${err.message}`);
      return false;
    }
  } else {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release().catch(() => {});
      wakeLockSentinel = null;
    }
    if (onChange) onChange(false, 'Wake Lock off.');
    return false;
  }
}

export function isWakeLockActive() {
  return Boolean(wakeLockSentinel);
}
