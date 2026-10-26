/**
 * The Settings feature checklist.
 *
 * Each entry is one thing the app is supposed to be able to do — write a file,
 * read a tag, decode audio, remember a queue — exercised against the real
 * implementation on this device. Nothing here is a mock: the checks call the
 * same functions the screens do, so a pass is evidence a feature works and a
 * failure names the part that does not.
 *
 * The shapes and the report are pure so `scripts/check.mts` covers them without
 * a device; the runs themselves live in `featureAudit.ts`.
 */

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface FeatureCheck {
  id: string;
  /** Row title in Settings. */
  label: string;
  /** What the check proves, in one line. */
  intent: string;
  status: CheckStatus;
  /** What happened, in one line. */
  note: string;
  /** Raw output worth pasting into a report: native errors, FFmpeg text. */
  detail?: string;
  /** Wall-clock time the check took. */
  ms: number;
}

export interface CheckOutcome {
  status: CheckStatus;
  note: string;
  detail?: string;
}

export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** True when nothing failed. Skips are not failures. */
  ok: boolean;
  /** One line for the Settings row. */
  label: string;
}

export function summarizeChecks(checks: readonly FeatureCheck[]): CheckSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const check of checks) {
    if (check.status === 'pass') passed += 1;
    else if (check.status === 'fail') failed += 1;
    else skipped += 1;
  }

  const total = checks.length;
  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  return {
    total,
    passed,
    failed,
    skipped,
    ok: total > 0 && failed === 0,
    label: total === 0 ? 'Not run yet' : `${parts.join(' · ')} of ${total}`,
  };
}

export interface ReportContext {
  version?: string;
  device?: string;
  at?: number;
}

/** Plain text, for the share sheet and for pasting into a bug report. */
export function formatCheckReport(
  checks: readonly FeatureCheck[],
  context: ReportContext = {},
): string {
  const summary = summarizeChecks(checks);
  const header = ['Resonance feature check'];

  if (context.version) header.push(`Version: ${context.version}`);
  if (context.device) header.push(`Device: ${context.device}`);
  if (context.at) header.push(`Run: ${new Date(context.at).toISOString()}`);
  header.push(`Result: ${summary.label}`);

  const lines = checks.map((check) => {
    const mark = check.status === 'pass' ? 'pass' : check.status === 'fail' ? 'FAIL' : 'skip';
    return `[${mark}] ${check.label} — ${check.note}`;
  });

  const details = checks
    .filter((check) => check.detail && check.status !== 'pass')
    .map((check) => `${check.label}:\n${check.detail}`);

  return [header.join('\n'), lines.join('\n'), details.join('\n\n')]
    .filter((block) => block.length > 0)
    .join('\n\n');
}

/** Row icon and colour key for a status, kept out of the screen. */
export function statusMeta(status: CheckStatus): { icon: string; tone: 'good' | 'bad' | 'muted' } {
  if (status === 'pass') return { icon: 'checkmark-circle', tone: 'good' };
  if (status === 'fail') return { icon: 'close-circle', tone: 'bad' };
  return { icon: 'remove-circle-outline', tone: 'muted' };
}
