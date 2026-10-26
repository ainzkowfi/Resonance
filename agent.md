# Resonance - Project Outline

## Overview

Resonance is a local-first music player for Android built with React Native and Expo. It focuses on offline playback of local audio files with features like queue management, playlists, lyrics, lock screen controls, a polished dark UI, and an on-device audio analysis pipeline that powers waveforms, volume leveling and silence skipping. The app is designed to work entirely offline without cloud dependencies.

**Key Characteristics:**
- **Platform**: Android (web preview available via Expo; analysis and waveform features are native-only)
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
- **expo-dev-client**: ~58.0.14 (background audio and the inline native module need a development build)
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
│   ├── components/       # Reusable UI components (incl. Waveform.tsx)
│   ├── media/             # Native codec access and the analysis pipeline
│   │   ├── module.ts      # Lazy, guarded requireNativeModule('MediaAudioModule')
│   │   ├── probe.ts       # On-device codec capability check
│   │   └── waveform.ts    # Decode → analyse → cache per track
│   ├── native/            # Inline Kotlin module (MediaCodec decode to WAV)
│   ├── hooks/            # Custom React hooks
│   ├── lib/              # Pure logic: parsers, maths, formatting
│   ├── library/          # Local library scanning logic
│   ├── store/            # Zustand stores (player, library, analysis, diagnostics)
│   ├── theme/            # Design tokens and theming
│   └── types/            # TypeScript type definitions
├── assets/               # Static assets (icons, images)
├── scripts/              # check.mts — the headless test suite
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
- **Persistence**: Persists queue, current track, position, shuffle/repeat settings, leveling data and crossfade length to AsyncStorage (with deduplication)
- **Audio Engine Integration**: Delegates playback to `audioEngine`, listens for status updates
- **Feature Wiring**: Preload trigger, crossfade timing, silence skip in/out points, per-track gain
- **Auto-restore**: Restores playback state on app restart
- **Migration Logic**: Handles schema changes across versions

#### Library Store (`src/store/library.ts`)
Manages local music library. Key responsibilities:
- **Scanning**: Discovers local audio files via `library/local.ts`
- **Filtering**: Apply hidden tracks, duration filters, metadata overrides
- **Playlists**: Create/manage playlists stored in AsyncStorage
- **Albums/Artists**: Grouped views computed from filtered tracks
- **Caching**: Caches library scans for performance
- **Sync**: Incremental sync when folder contents change
- **Permissions**: Handles audio/media permissions

#### Analysis Run Store (`src/store/analysis.ts`)
Drives the explicit batch analysis pass:
- Plans the queue with `planAnalysisQueue` (skips cached tracks, caps at 200 per run)
- Decodes one track at a time, feeding measured loudness back into the player store
- Cancellable through a run token, so a loop mid-decode cannot write stale state
- Counts already-analysed tracks in 250-track chunks to avoid stalling the UI

#### Diagnostics Store (`src/store/diagnostics.ts`)
In-memory, session-only log:
- **Issues**: Last 12 caught failures with scope, message and raw detail
- **Fatal errors**: Last render/runtime error plus component stack, shown as an overlay from the root layout instead of a force close
- **Probe**: Last codec capability report
- **Handoffs**: Last 20 measured track transitions

### Audio Engine (`src/audio/engine.ts`)
Singleton that wraps `expo-audio`. Design principles:
- **One active player**: Only one track plays at a time; the queue is managed by the store. Two exceptions exist by design: a fading-out player during a crossfade and a hidden standby player holding the preloaded next track.
- **No store dependency**: Pushes status updates via listener (prevents circular deps)
- **Gain bus**: `player.volume` is `levelingGain × fadeGain`. Nothing else writes volume, so automatic leveling and a crossfade ramp cannot overwrite each other.
- **Background playback**: Configured with `shouldPlayInBackground: true`, `playsInSilentMode: true`, `doNotMix` mode
- **Lock screen controls**: Updates metadata for lock screen/notification controls
- **Robust loading**: Token-based cancellation for superseded loads, error handling; a released player's late status event is ignored (it is no longer the active player)
- **Seek management**: Queues seeks until player is ready/buffered
- **Status reporting**: Emits playback status every 250 ms, with `currentTime` used for sub-tick handoff timing

### Track Handoff and Preloading
There is no true gapless playback: `expo-audio` has no playlist API, so one player per source always leaves a start gap. Instead the gap is measured and reduced:

- **Preload** (`src/lib/preload.ts`, `engine.prepare()`): 15 seconds before a track ends, the successor is opened in a hidden player at volume 0. At the boundary `promote()` rebinds status, takes the lock-screen binding, retires the old player and calls `play()` on an already-open source. `replace()` retargets the standby when the queue changes, keeping it cheap.
- **Measurement** (`src/lib/handoff.ts`): every transition records *queue delay* (asked to load → `play()` called, clock started before teardown) and *start latency* (`play()` → audio moving, with the player's reported position subtracted). Samples above 5 s are discarded as stalls, and crossfaded transitions are excluded from the summary so the hard-cut number stays meaningful.
- **Comparison**: Diagnostics reports preloaded and cold medians separately. If they match, `expo-audio` is loading lazily on `play()`, preloading bought nothing, and the standby player should be deleted.

### Audio Analysis Pipeline (`src/media/`, `src/lib/wav.ts`)
One PCM decode per track yields everything the features need. This replaced an earlier `showwavespic` approach that could not work through the `ffmpeg-expo` build, which crashed on decode.

- **Decode**: native `MediaAudioModule.decodeToWav` (MediaCodec) → mono, 8 kHz, first 15 minutes into the cache
- **Derive in JS** (`analyzeWav`): 512 normalised peaks, dBFS RMS over non-silent frames, sample peak, and near-silence seconds at lead and tail
- **Cache**: JSON per track under `cache/waveforms`, `CACHE_VERSION = 3`; stale versions are re-decoded rather than read
- **Safety**: lazy guarded `requireNativeModule` (throws when the build lacks the module), 60 s native decode budget, crash marker (`waveform:pending-run`) that disables analysis for the session after a native crash, in-flight dedupe so concurrent requests share one decode
- **Maintenance**: `pruneAnalysis` deletes cache files for tracks that left the library; there is no UI yet to clear the cache or inspect it

What the device supports is checked on demand by Settings → Diagnostics → "Check codec support", which lists `MediaCodecList` decoders/encoders and then runs a real one-second decode self-test rather than trusting a spec sheet.

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
  gain?: number;           // ReplayGain dB, used when no RMS measurement exists
  lyricsUri?: string;      // Sidecar .lrc/.txt for lyrics
}
```

#### TrackAnalysis (`src/media/waveform.ts`)
```typescript
interface TrackAnalysis {
  peaks: number[];   // 512 normalised 0..1 columns
  rmsDb: number;     // dBFS RMS — the leveling input
  peakDb: number;    // dBFS sample peak
  lead: number;      // Seconds of near-silence at the start
  tail: number;      // Seconds of near-silence at the end
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
- Seek within track, with a waveform scrubber when analysis is available
- Queue management with reordering
- Shuffle mode (preserves original queue)
- Repeat modes (off, repeat one, repeat all)
- Background playback with lock screen controls
- Auto-play next track on completion
- Resume playback position after app restart
- Crossfade of 0–12 seconds (whole seconds; 0 is a hard cut)
- Preloaded track handoff with measured timing

### Volume Leveling (`src/lib/leveling.ts`)
- Aims every track at the library's median measured loudness
- **Attenuation only**: `expo-audio` caps volume at 1, so quiet masters are not boosted. This halves the spread between loud and quiet masters instead of pretending otherwise.
- Falls back to the ReplayGain tag for unanalysed tracks; below 5 measurements it targets −16 dBFS
- Attenuation capped at 18 dB, applied through the engine's gain bus as a multiplier

### Silence Skipping (`src/lib/silence.ts`)
- Skips more than 2 seconds of near-silence at the start or end of a track
- Lead skip never overrides a resume checkpoint; a track barely longer than its own outro is left alone

### Crossfade (`src/lib/crossfade.ts`)
- Two players with a 50 ms volume ramp; the store advances early so the blend lands on the boundary
- Takes the earlier of the blend start and the silence-skip out point
- Applies to queue advance and the next button only — `previous`, picking a track directly, and repeat-one stay hard cuts
- A track barely longer than twice the blend is not blended, which would otherwise trigger an advance loop
- Pausing during a blend pauses both players

### Audio Analysis
- Explicit, cancellable batch pass over up to 200 uncached tracks, one decode at a time
- Runs on demand only; nothing decodes in the background unasked
- Produces waveform peaks, loudness for leveling, and silence bounds in one decode
- Per-track cache with automatic pruning of departed tracks

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
- Full player screen with artwork, lyrics view, waveform scrubber
- Queue modal
- Track context menu
- Gesture-based interactions
- Haptic feedback
- Smooth animations (Reanimated)
- Blur effects

### Settings
- **Library**: refresh/rescan, minimum duration, track counts, hidden tracks
- **Analysis**: analysed/total count, start or cancel a batch run with progress
- **Playback**: volume leveling, skip silence, crossfade length
- **Diagnostics**: codec inventory, capability probe with shareable report, handoff timing (preloaded vs cold), recent problems and a shareable error log
- **Credits**

### Lyrics Support
- Reads sidecar `.lrc` or `.txt` files next to audio files
- Parses LRC format with timestamps (`lib/lrc.ts`)
- Lyrics view component for synced/plain lyrics

### Utilities (`src/lib/`)
- **format.ts**: Time formatting, shuffle algorithm, stable ids
- **id3.ts**: ID3 tag parsing
- **tags.ts**: Tag extraction utilities
- **lrc.ts**: LRC lyrics parser
- **lyrics.ts**: Lyrics loading logic
- **fuzzy.ts**: Fuzzy search
- **filter.ts**: Library filtering logic
- **colors.ts**: Color utilities
- **bytes.ts**: Byte formatting
- **wav.ts**: WAV decoding, peak/RMS/silence analysis
- **waveform.ts**: Peak resampling to screen width
- **leveling.ts**: Loudness target and gain maths
- **silence.ts**: Lead/tail skip bounds
- **crossfade.ts**: Blend length and start time
- **preload.ts**: When to open the next track
- **handoff.ts**: Transition timing and summary
- **analysisQueue.ts**: Which tracks a batch run should decode
- **codecReport.ts**: Capability report formatting for the codec probe
- **errorHandler.ts**: Global JS error handler installation

## Configuration

### app.json Highlights
- **Name**: Resonance
- **Scheme**: resonance (deep linking)
- **Orientation**: Portrait only
- **UI Style**: Dark
- **Android**: Permissions for READ_MEDIA_AUDIO, POST_NOTIFICATIONS, WAKE_LOCK
- **Plugins**: expo-router, expo-image, expo-font, expo-audio (background playback), expo-media-library (granular audio permissions)
- **Experiments**: Typed routes enabled

### Environment & Permissions
- **Android**: Runtime permissions for media access

## Scripts

```json
{
  "start": "expo start",           // Start dev server
  "android": "expo run:android",   // Run on Android
  "web": "expo start --web",       // Start on web
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
- Feature maths lives in `src/lib/` as pure functions and is tested by `scripts/check.mts`; native calls are thin wrappers around them

### Important Patterns
1. **Store-Engine Communication**: Player store calls `audioEngine` methods; engine reports back via `setStatusListener`
2. **Gain Bus**: volume is owned by the engine (`setLevelGain` × fade), never written directly by stores or screens
3. **Persistence Strategy**: Deduplicated AsyncStorage writes, selective partialize for player state
4. **Error Resilience**: Audio loads wrapped in try/catch, failures don't crash app
5. **Lazy Native Imports**: `MediaAudioModule` is required inside a guarded function, never at module top level, so a build without it degrades instead of crashing
6. **Migration Safety**: Library store migrates local tracks only (filters out online URLs); analysis caches are versioned and re-decoded when stale
7. **Background Audio**: Properly configured for lock screen controls

### Native Code
- `ios/` and `android/` directories are generated (Continuous Native Generation/CNG)
- Native behavior configured via `app.json`; the audio decoder is an inline Kotlin module (`src/native/MediaAudioModule.kt`) picked up by `experiments.inlineModules`
- Requires development build (not Expo Go) due to native modules (expo-audio with background playback, the inline MediaCodec module)

## Testing & Quality
- `npm run check` — headless suite (`scripts/check.mts`) covering tag parsers, LRC, filtering, fuzzy search, WAV analysis, codec-report formatting, leveling, silence, waveform resampling, analysis queue, crossfade, handoff timing and preload: **294 checks**
- `npx tsc --noEmit` and `npx expo lint` before committing (per AGENTS.md)
- `npx expo export --platform android` as a bundle sanity check
- What the suite cannot cover: anything native. Codec availability, decode accuracy, waveform shape against the audio, crossfade smoothness, preload behaviour and handoff numbers all need a device build. Settings → Diagnostics is the intended place to read those results.

## Known Limitations
- No true gapless playback (see above); the gap is measured and reduced, not removed
- Leveling can only attenuate, never boost
- Waveform, leveling and silence skipping need the native module, so they are unavailable on web and in Expo Go
- Analysis is capped at the first 15 minutes of a track and 200 tracks per batch run
- Clip/ringtone export is not built; it would need a MediaCodec encoder + MediaMuxer path that does not exist yet

## Potential Extension Points
- Clip/ringtone export with a trim range on the waveform and a SAF output folder
- Analysis cache management in the UI (inspect and clear); `deleteWaveform` exists but is unused
- Streaming support (currently only local files)
- Equalizer
- Sleep timer
- CarPlay/Android Auto
- Lyrics download/sync
- Playlist import/export
- Theme customization
- Widget support
