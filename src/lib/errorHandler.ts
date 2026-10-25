import { describeError, useDiagnosticsStore } from '../store/diagnostics';

/**
 * Buys the app a screen instead of a force close.
 *
 * React Native's default global handler terminates the process for fatal JS
 * errors, which leaves nothing to copy. Installing our own handler keeps the
 * runtime alive: fatal errors raise the error overlay from the root layout,
 * everything else is appended to the diagnostics log in Settings.
 *
 * Render-time errors never reach this handler — those are caught by the
 * `ErrorBoundary` exported from the root layout.
 */
export function installGlobalErrorHandler(): () => void {
  // React Native installs this global. Guard with typeof so a non-RN runtime
  // (the web preview) does not throw on a bare reference.
  if (typeof ErrorUtils === 'undefined' || !ErrorUtils) return () => {};

  const previous = ErrorUtils.getGlobalHandler();

  ErrorUtils.setGlobalHandler((error, isFatal) => {
    const store = useDiagnosticsStore.getState();
    if (isFatal) {
      store.setFatal(error);
    } else {
      const info = describeError(error);
      store.addIssue('javascript', info.message, info.stack);
    }
    if (__DEV__) {
      console.error('[global]', isFatal ? 'fatal' : 'handled', error);
    }
  });

  return () => ErrorUtils.setGlobalHandler(previous);
}
