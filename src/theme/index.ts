import { Platform } from 'react-native';

/**
 * Motion system. Everything is fast on purpose: the user asked for animation
 * everywhere, so the only way it stays pleasant is if nothing ever takes
 * longer than ~320ms and springs stay under ~18% overshoot.
 */
export const motion = {
  fast: 140,
  base: 200,
  slow: 300,
  /** Lyrics scroll between lines. */
  lyric: 260,
  spring: {
    /** Snappy, for taps and small elements. */
    snappy: { damping: 18, stiffness: 320, mass: 0.7 },
    /** Smooth, for layout morphs. */
    smooth: { damping: 22, stiffness: 180, mass: 0.9 },
    /** Bouncy, for the play button and artwork. */
    bouncy: { damping: 14, stiffness: 260, mass: 0.8 },
  },
} as const;

/**
 * Apple-style light palette. Groups sit on `bg`, cards on `surface`, and
 * `glass` is the translucent fill glass surfaces fall back to where a real
 * blur is unavailable.
 */
export const palette = {
  bg: '#F2F2F7',
  bgElevated: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceHi: '#EFEFF4',
  border: 'rgba(60,60,67,0.10)',
  borderHi: 'rgba(60,60,67,0.20)',
  text: '#1C1C1E',
  textDim: 'rgba(60,60,67,0.62)',
  textFaint: 'rgba(60,60,67,0.36)',
  accent: '#6B4EFF',
  accentAlt: '#00A37E',
  danger: '#FF3B30',
  scrim: 'rgba(0,0,0,0.35)',
  glass: 'rgba(255,255,255,0.66)',
  glassBorder: 'rgba(255,255,255,0.85)',
} as const;

/** Minimum comfortable touch target. Apple's HIG says 44pt; we use 48 for rows. */
export const HIT = {
  min: 44,
  comfortable: 56,
  primary: 72,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
  xl: 32,
  pill: 999,
} as const;

export const spacing = (n: number) => n * 4;

export const font = {
  display: { fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.8 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.4 },
  body: { fontSize: 15, fontWeight: '500' as const },
  label: { fontSize: 13, fontWeight: '600' as const },
  caption: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.6 },
};

export const shadow = {
  card: Platform.select({
    ios: {
      shadowColor: '#1C1C1E',
      shadowOpacity: 0.12,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 4 },
    default: {},
  }) as object,
  glow: Platform.select({
    ios: {
      shadowColor: '#6B4EFF',
      shadowOpacity: 0.22,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 8 },
    default: {},
  }) as object,
};
