import { Platform } from 'react-native';
import { create } from 'zustand';

/**
 * In-memory crash / failure log.
 *
 * Native crashes cannot be caught from JavaScript, but everything that *can* be
 * caught is recorded here so it can be shown on the error screen or copied out
 * of Settings and handed to an agent.
 */

export interface DiagnosticIssue {
  id: string;
  at: number;
  /** Where it happened, e.g. `waveform`. */
  scope: string;
  message: string;
  /** Raw native/FFmpeg output, stack trace, etc. */
  detail?: string;
}

export interface FatalError {
  at: number;
  message: string;
  stack?: string;
  componentStack?: string;
}

const MAX_ISSUES = 12;

interface DiagnosticsState {
  issues: DiagnosticIssue[];
  fatal: FatalError | null;
  addIssue: (scope: string, message: string, detail?: string) => void;
  clearIssues: () => void;
  setFatal: (error: unknown, componentStack?: string) => void;
  clearFatal: () => void;
}

let seq = 0;

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  issues: [],
  fatal: null,
  addIssue: (scope, message, detail) =>
    set((state) => ({
      issues: [
        { id: `issue-${++seq}`, at: Date.now(), scope, message, detail },
        ...state.issues,
      ].slice(0, MAX_ISSUES),
    })),
  clearIssues: () => set({ issues: [] }),
  setFatal: (error, componentStack) => set({ fatal: describeError(error, componentStack) }),
  clearFatal: () => set({ fatal: null }),
}));

export function describeError(error: unknown, componentStack?: string): FatalError {
  const at = Date.now();
  if (error instanceof Error) {
    return { at, message: error.message || error.name, stack: error.stack, componentStack };
  }
  if (typeof error === 'string') return { at, message: error, componentStack };
  try {
    return { at, message: JSON.stringify(error), componentStack };
  } catch {
    return { at, message: String(error), componentStack };
  }
}

export function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Plain-text block, meant to be pasted into a chat with an agent. */
export function formatIssues(issues: DiagnosticIssue[]): string {
  if (issues.length === 0) return 'No problems recorded.';
  return issues
    .map((issue) => {
      const head = `[${formatTime(issue.at)}] ${issue.scope}: ${issue.message}`;
      return issue.detail ? `${head}\n${issue.detail}` : head;
    })
    .join('\n\n');
}

export function formatFatal(fatal: FatalError): string {
  const parts = [`[${formatTime(fatal.at)}] ${fatal.message}`];
  if (fatal.stack) parts.push('', fatal.stack);
  if (fatal.componentStack) parts.push('', 'Component stack:', fatal.componentStack);
  parts.push('', `${Platform.OS} ${Platform.Version}`);
  return parts.join('\n');
}
