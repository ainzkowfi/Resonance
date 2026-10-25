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
  /** One full pass of the highlight drifting across a glass surface. */
  liquid: 7200,
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
 * Deep-sea glass palette. Cool near-black surfaces keep artwork colours
 * dominant; icy cyan and mint carry interaction, with violet reserved for
 * selection. Values follow the QuickLiquid reference, tuned for OLED screens.
 */
export const palette = {
  bg: '#04060C',
  bgElevated: '#101721',
  surface: '#0A0E16',
  surfaceHi: '#131D27',
  border: 'rgba(213,228,236,0.14)',
  borderHi: 'rgba(213,228,236,0.26)',
  text: '#EDF5F7',
  textDim: 'rgba(237,245,247,0.72)',
  textFaint: 'rgba(237,245,247,0.48)',
  accent: '#9AF2FF',
  accentAlt: '#7BE5C9',
  accentViolet: '#C084FC',
  danger: '#FF8C9A',
  scrim: 'rgba(2,4,8,0.66)',
  glass: 'rgba(10,16,25,0.62)',
  glassTint: 'rgba(148,163,184,0.08)',
  glassBorder: 'rgba(213,228,236,0.26)',
  /** Perimeter of a glass surface: visible, but never bright enough to read as a rule. */
  glassEdge: 'rgba(213,228,236,0.16)',
  glassHighlight: 'rgba(255,255,255,0.34)',
  selection: 'rgba(154,242,255,0.12)',
  selectionStrong: 'rgba(154,242,255,0.20)',
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
      shadowColor: '#000000',
      shadowOpacity: 0.36,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 10 },
    },
    android: { elevation: 4 },
    default: {},
  }) as object,
  glow: Platform.select({
    ios: {
      shadowColor: '#9AF2FF',
      shadowOpacity: 0.28,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 8 },
    default: {},
  }) as object,
};
