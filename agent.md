# Resonance - Project Outline

## Overview

Resonance is a local-first music player for iOS and Android built with React Native and Expo. It focuses on offline playback of local audio files with features like queue management, playlists, lyrics, lock screen controls, and a polished dark UI. The app is designed to work entirely offline without cloud dependencies.

**Key Characteristics:**
- **Platform**: iOS, Android, Web (via Expo)
- **Type**: Mobile-first music player
- **Architecture**: Local-first, offline-focused
- **License**: See LICENSE file

## Tech Stack

### Core Framework
- **Expo SDK**: ~58.0.16
- **React**: 19.3.0
- **React Native**: 0.88.0
- **Expo Router**: ~58.0.24 (file-based routing, typed routes enabled)
- **TypeScript**: ~6.0.3 (strict mode)

### State Management
- **Zustand**: ^5.0.15 with persistence middleware
- AsyncStorage for persistent state

### Audio & Media
- **expo-audio**: ~58.0.9 (audio playback engine with background support)
- **expo-media-library**: ~58.0.11 (access to device media library)
- **expo-file-system**: ~58.0.10 (file operations)
- **react-native-gesture-handler**: ~3.3.0
- **react-native-reanimated**: 4.7.1

### UI & Styling
- **@gorhom/bottom-sheet**: ^5.2.14
- **expo-blur**: ~58.0.5
- **expo-haptics**: ~58.0.7
- **expo-image**: ~58.0.16
- **expo-linear-gradient**: ~58.0.3
- **react-native-svg**: 15.16.0
- **react-native-safe-area-context**: ~5.10.1
- **react-native-screens**: ~4.30.0

### Utilities
- **@react-native-async-storage/async-storage**: 2.2.0
- **@expo/vector-icons**: ^15.0.2

## Project Structure

```
resonance/
├── src/
│   ├── app/              # Expo Router routes (screens)
│   │   ├── _layout.tsx   # Root layout with providers
│   │   ├── (tabs)/       # Tab navigator (Home, Search, Settings)
│   │   ├── playlist/     # Playlist detail screens
│   │   ├── track/        # Track detail screens
│   │   ├── queue.tsx     # Queue modal
│   │   └── hidden.tsx    # Hidden tracks modal
│   ├── audio/            # Audio playback engine
│   │   └── engine.ts     # Singleton audio engine wrapping expo-audio
│   ├── components/       # Reusable UI components
│   ├── hooks/            # Custom React hooks
│   ├── lib/              # Utility functions (parsers, formatters, etc.)
│   ├── library/          # Local library scanning logic
│   ├── store/            # Zustand stores
│   ├── theme/            # Design tokens and theming
│   └── types/            # TypeScript type definitions
├── assets/               # Static assets (icons, images)
├── scripts/              # Build/utility scripts
├── app.json              # Expo configuration
├── package.json          # Dependencies and scripts
└── tsconfig.json         # TypeScript configuration
```

## Architecture

### Navigation (Expo Router)
Routes are file-based under `src/app/`. Non-route code stays outside `src/app/`.
- **Root Layout** (`src/app/_layout.tsx`): Sets up GestureHandlerRootView, SafeAreaProvider, StatusBar, Stack navigator with modals
- **Tab Navigator** (`src/app/(tabs)/`): Main navigation with index, search, and settings tabs
- **Modal Routes**: `queue.tsx`, `hidden.tsx` presented as modals from bottom
- **Stack Routes**: `track/[id].tsx`, `playlist/[id].tsx` with slide animations

### State Management (Zustand)

#### Player Store (`src/store/player.ts`)
Manages queue and playback state. Key responsibilities:
- **Queue Management**: Add tracks, navigate (next/previous), reorder, remove
- **Playback Control**: Play/pause/toggle, seek, repeat modes (off/one/all), shuffle
- **Persistence**: Persists queue, current track, position, shuffle/repeat settings to AsyncStorage (with deduplication)
- **Audio Engine Integration**: Delegates playback to `audioEngine`, listens for status updates
- **Auto-restore**: Restores playback state on app restart
- **Migration Logic**: Handles schema changes across versions (v1-v3)

#### Library Store (`src/store/library.ts`)
Manages local music library. Key responsibilities:
- **Scanning**: Discovers local audio files via `library/local.ts`
- **Filtering**: Apply hidden tracks, duration filters, metadata overrides
- **Playlists**: Create/manage playlists stored in AsyncStorage
- **Albums/Artists**: Grouped views computed from filtered tracks
- **Caching**: Caches library scans for performance
- **Sync**: Incremental sync when folder contents change
- **Permissions**: Handles audio/media permissions

### Audio Engine (`src/audio/engine.ts`)
Singleton that wraps `expo-audio`. Design principles:
- **Single Player Instance**: Only one track plays at a time; queue is managed by store
- **No Store Dependency**: Pushes status updates via listener (prevents circular deps)
- **Background Playback**: Configured with `shouldPlayInBackground: true`, `playsInSilentMode: true`, `doNotMix` mode
- **Lock Screen Controls**: Updates metadata for lock screen/notification controls
- **Robust Loading**: Token-based cancellation for superseded loads, error handling
- **Seek Management**: Queues seeks until player is ready/buffered
- **Status Reporting**: Emits playback status (position, duration, playing state, completion) every 250ms

### Library Scanning (`src/library/local.ts`)
Handles discovery and parsing of local audio files:
- **Permission Requests**: iOS/Android permission handling
- **Folder Picking**: Allows user to select music directory
- **File Scanning**: Recursively scans for audio files
- **Metadata Extraction**: Uses `lib/id3.ts`, `lib/tags.ts` for tag parsing
- **Sync Logic**: Incrementally updates when files added/removed
- **Album Art**: Extracts/handles artwork

### Data Model

#### Track (`src/types/track.ts`)
```typescript
interface Track {
  id: string;              // Stable ID derived from URI
  source: 'local';         // Only local source supported
  uri: string;             // Local file URI
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  artwork?: string;
  duration: number;        // Seconds
  // Extended metadata (ID3 tags)
  genre?, composer?, year?, trackNumber?, discNumber?, etc.
  lyricsUri?: string;      // Sidecar .lrc/.txt for lyrics
}
```

#### Lyrics (`src/types/track.ts`)
```typescript
interface Lyrics {
  synced?: string;         // LRC format with timestamps
  plain?: string;          // Plain text
  source: 'local';
}
```

#### Repeat Modes
`'off' | 'one' | 'all'`

## Key Features

### Playback
- Play/pause, next/previous track
- Seek within track
- Queue management with reordering
- Shuffle mode (preserves original queue)
- Repeat modes (off, repeat one, repeat all)
- Background playback with lock screen controls
- Auto-play next track on completion
- Resume playback position after app restart

### Library Management
- Scan local device storage for audio files
- Browse by Tracks, Albums, Artists, Playlists
- Search functionality
- Hide/unhide tracks
- Override track metadata (title, artist, album, artwork)
- Filter by minimum duration
- Delete files from device
- Create and manage custom playlists

### UI/UX
- Dark theme (`#04060C` background)
- Bottom player bar
- Full player screen with artwork, lyrics view
- Queue modal
- Track context menu
- Gesture-based interactions
- Haptic feedback
- Smooth animations (Reanimated)
- Blur effects

### Lyrics Support
- Reads sidecar `.lrc` or `.txt` files next to audio files
- Parses LRC format with timestamps (`lib/lrc.ts`)
- Lyrics view component for synced/plain lyrics

### Utilities (`src/lib/`)
- **format.ts**: Time formatting, shuffle algorithm
- **id3.ts**: ID3 tag parsing
- **tags.ts**: Tag extraction utilities
- **lrc.ts**: LRC lyrics parser
- **lyrics.ts**: Lyrics loading logic
- **fuzzy.ts**: Fuzzy search
- **filter.ts**: Library filtering logic
- **colors.ts**: Color utilities
- **bytes.ts**: Byte formatting

## Configuration

### app.json Highlights
- **Name**: Resonance
- **Scheme**: resonance (deep linking)
- **Orientation**: Portrait only
- **UI Style**: Dark
- **iOS**: Background audio enabled, media library permissions
- **Android**: Permissions for READ_MEDIA_AUDIO, POST_NOTIFICATIONS, WAKE_LOCK
- **Plugins**: expo-router, expo-image, expo-font, expo-audio (background playback), expo-media-library (granular audio permissions)
- **Experiments**: Typed routes enabled

### Environment & Permissions
- **iOS InfoPlist**: `NSAppleMusicUsageDescription`, `UIBackgroundModes: ["audio"]`
- **Android**: Runtime permissions for media access

## Scripts

```json
{
  "start": "expo start",           // Start dev server
  "android": "expo run:android",   // Run on Android
  "ios": "expo run:ios",           // Run on iOS
  "web": "expo start --web",       // Run on web
  "typecheck": "tsc --noEmit",     // Type checking
  "lint": "expo lint",             // Linting
  "check": "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/check.mts"
}
```

## Development Notes

### Code Conventions
- Strict TypeScript enabled
- Path alias `@/*` maps to `./src/*`
- Expo Router file-based routing
- Components outside `src/app/` directory
- Zustand stores for global state
- Audio engine decoupled from stores (listener pattern)

### Important Patterns
1. **Store-Engine Communication**: Player store calls `audioEngine` methods; engine reports back via `setStatusListener`
2. **Persistence Strategy**: Deduplicated AsyncStorage writes, selective partialize for player state
3. **Error Resilience**: Audio loads wrapped in try/catch, failures don't crash app
4. **Migration Safety**: Library store migrates local tracks only (filters out online URLs)
5. **Background Audio**: Properly configured for lock screen controls

### Native Code
- `ios/` and `android/` directories not present (uses Continuous Native Generation/CNG)
- Native behavior configured via `app.json` and config plugins
- Requires development build (not Expo Go) due to native modules (expo-audio with background playback)

## Testing & Quality
- ESLint with `eslint-config-expo`
- TypeScript strict mode
- Run `npx tsc --noEmit` and `npx expo lint` before committing (per AGENTS.md)

## Potential Extension Points
- Streaming support (currently only local files)
- Equalizer
- Crossfade
- Sleep timer
- CarPlay/Android Auto
- Lyrics download/sync
- Playlist import/export
- Theme customization
- Widget support
