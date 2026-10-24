import { create } from 'zustand';

interface PlayerSurfaceState {
  /** True while the full-screen player is showing. */
  expanded: boolean;
  open: () => void;
  close: () => void;
}

/**
 * The player is a surface over the tabs rather than a route, so opening it is
 * a shared-value animation instead of a navigation transition.
 */
export const usePlayerSurface = create<PlayerSurfaceState>((set) => ({
  expanded: false,
  open: () => set({ expanded: true }),
  close: () => set({ expanded: false }),
}));

export const openPlayer = () => usePlayerSurface.getState().open();
export const closePlayer = () => usePlayerSurface.getState().close();
