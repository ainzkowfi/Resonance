# FFmpeg Integration Analysis for Resonance

## Current State Assessment

Resonance is a local-first music player using:
- **Audio playback**: `expo-audio` (native playback engine)
- **File access**: SAF (Storage Access Framework) on Android, MediaStore as fallback
- **Metadata parsing**: Custom tag parsers in `src/lib/tags.ts` reading raw bytes (ID3, FLAC, OGG, MP4/M4A, etc.)
- **Already has**: `gain` field in Track type, parsed from ReplayGain tags, displayed in track details but **not applied during playback**

The app is well-architected but has several gaps that FFmpeg could potentially address.

## FFmpeg Capabilities vs App Needs

### High-Value, Practical Features

| Feature | Use Case | Feasibility | Notes |
|---------|----------|-------------|-------|
| **ReplayGain/Loudness Normalization** | Normalize volume across tracks from different sources (EBU R128 `loudnorm` filter) | ★★★★☆ High | Track already has `gain` field parsed but unused. Biggest UX improvement. Better to pre-process and cache normalized versions. |
| **Waveform Generation** | Visual waveform in progress bar/UI for better seeking | ★★★★☆ High | FFmpeg can generate waveform data/images. Pre-generate once per track, cache as JSON/PNG. Much better UX than simple progress bar. |
| **Audio Trimming** | Let users trim intros/outros, create clips/ringtones | ★★★★☆ High | User-initiated on specific tracks, not bulk. Easy with FFmpeg `atrim`/`trim`. Good for a "local music player" feature set. |
| **Silence Trimming** | Auto-remove leading/trailing silence | ★★★★☆ High | Uses `silenceremove` filter. Nice quality-of-life feature. |
| **Format Conversion/Transcoding** | Handle files that don't play well in expo-audio, or standardize formats | ★★★★☆ High | Copy to cache dir as compatible format (AAC in MP4 container) if needed. |
| **Crossfading Preparation** | Pre-generate crossfaded transitions between tracks | ★★★☆☆ Medium-High | Nice for seamless playback, but complex to manage. Could generate on-demand or cache. |

### Medium/Questionable Value

| Feature | Use Case | Feasibility | Notes |
|---------|----------|-------------|-------|
| **Playback Speed/Pitch Control** | Speed up/down without pitch change (`atempo`, `rubberband`) | ★★★☆☆ Medium | expo-audio may have limited support; FFmpeg filtering during playback is complex for low latency. Better as pre-processing or if expo-audio can't do it well. |
| **Audio Effects (EQ, reverb)** | Equalizer, audio processing | ★★☆☆☆ Low-Medium | Real-time EQ with FFmpeg has latency issues. expo-audio might be better suited, or use native audio processing. |
| **Metadata Extraction Fallback** | More robust parsing for unusual formats | ★★★★☆ High | App already has good parsers, but FFmpeg could be fallback for exotic formats. Probably not necessary given current implementation. |

### False Positives (Not Practical/Not Recommended)

| Feature | Why It's Not Practical | Recommendation |
|---------|------------------------|---------------|
| **Real-time stem separation/vocal removal** | Extremely CPU intensive, requires ML models (multi-GB), would take minutes per song on mobile, drains battery badly | **Skip** - Not feasible on mobile devices |
| **Batch normalization of entire library** | Processing hundreds/thousands of tracks would take hours, fill storage, drain battery | **Skip** as batch operation - Only do on-demand per track or with user consent |
| **Real-time audio effects during playback** | FFmpeg is not designed for low-latency real-time streaming. Would introduce lag, poor UX. Use native audio APIs instead. | **Skip** - Use expo-audio's capabilities or native modules |
| **AI upscaling/enhancement** | Requires large models, impractical on mobile | **Skip** |
| **Video processing** | App is a music player, not relevant to core functionality | **Skip** |

## Technical Considerations for Integration

### Challenges

1. **Package Maturity** - `ffmpeg-expo` by kingjnr4 is marked as "not stable for production use yet". This is a significant risk.
2. **Binary Size** - FFmpeg binaries add significant app size (several MB per architecture). Need to consider download size.
3. **Limited Codec Support** - Default LGPL build has no libmp3lame, no libx264/libx265, no libopus in some configs. As stated in README: "MP3, FLAC, H.265, VP9, Opus, Vorbis... are not included" in default build. This could break common use cases.
4. **Performance** - On-device processing is slow, especially on older devices. Need good UX (progress indicators, background processing).
5. **Storage Management** - Processed files need storage. Where to put them? Cache vs permanent storage. Need cleanup strategy.
6. **File Access Permissions** - SAF files on Android can be read-only in some contexts. Writing processed versions requires copying to app's cache directory.
7. **Build Complexity** - Requires development builds (app already does), config plugin setup, prebuild step.
8. **Expo Go Incompatibility** - Already not using Expo Go (needs dev builds) so this is fine.
9. **FFmpegKit Retirement** - Old FFmpegKit was discontinued Jan 2025, so alternatives are still maturing.

### Advantages

1. **Already needs dev builds** - No additional blocker there
2. **Local-first architecture** - On-device processing fits the app's philosophy
3. **Well-structured codebase** - Easy to add services/utils for FFmpeg
4. **File system abstraction exists** - `expo-file-system` usage patterns established

## Recommended Features to Add

Based on impact vs effort vs feasibility, I recommend adding these features in order:

### Priority 1: ReplayGain/Loudness Normalization
- **Why**: Track type already has `gain` field, parsed and displayed. This is the lowest-hanging fruit conceptually - the data is already there but unused.
- **Implementation**: 
  - Option A: Apply during playback using FFmpeg filters (complex, latency issues)
  - Option B: Pre-process tracks on-demand with `loudnorm` filter, cache normalized version
  - Option C: Use simple gain adjustment if ReplayGain tags present
- **Recommended**: Start with Option C (simple gain) using expo-audio's volume control if possible, or pre-process with `volume` filter. For true EBU R128 normalization, use `loudnorm`.
- **Storage**: Cache normalized files in app cache directory

### Priority 2: Waveform Generation
- **Why**: Major UI improvement, enhances the music player experience
- **Implementation**: Generate waveform data (peaks) using `showwavespic` filter or extract PCM data. Cache as JSON array of amplitudes.
- **UI**: Enhance ProgressBar to show waveform visualization
- **Storage**: Small JSON files (~few KB per track)

### Priority 3: Audio Trimming
- **Why**: Useful feature users expect in modern music apps
- **Implementation**: Add trim UI in track detail or context menu, use `atrim`/`trim` filters with re-encode
- **Output**: Save trimmed version to app directory or let user export

### Priority 4: Silence Trimming (Auto)
- **Why**: Cleans up tracks with long intros/outros
- **Implementation**: Use `silenceremove` filter, could be automatic or opt-in

## Implementation Plan Sketch

```typescript
// Proposed structure
src/
  ffmpeg/
    index.ts          // FFmpeg wrapper/service
    normalize.ts      // Loudness normalization
    waveform.ts       // Waveform generation
    trim.ts           // Audio trimming
    utils.ts          // File handling helpers
```

**Key considerations:**
- Only process on user action or with explicit opt-in (avoid surprise processing)
- Always work on copies in cache directory, never modify originals
- Show progress UI for long operations
- Handle errors gracefully
- Check if FFmpeg is available before using features
- Consider device capabilities

## Final Recommendation

**Should we add FFmpeg?** Conditionally yes, but **start small and carefully**.

**Recommended approach:**
1. **Evaluate first** - Add ffmpeg-expo as dev dependency, test in development build on real devices. See if it's stable enough for our needs.
2. **Start with waveform generation** - Lower risk, read-only operation (doesn't modify originals), big UI win, easy to make optional.
3. **Add ReplayGain normalization** - If users actually have tracks with different volumes, this is valuable. Start simple (apply gain from tags) before complex loudnorm.
4. **Skip advanced features initially** - Don't do stem separation, don't batch process library.

**Critical warnings:**
- ffmpeg-expo is still in early development - could have bugs or breaking changes
- Default codec support is limited - need to test with actual file formats in the user's library
- Processing time/battery impact - must be transparent to users
- APK/IPA size increase

**Alternative approach:** Consider if expo-audio can handle normalization via volume adjustment first. For waveform, we could also generate it differently. Only reach for FFmpeg if native solutions are insufficient.

Given this is a well-designed local music player, FFmpeg would add nice-to-have features but isn't critical. The most compelling additions are **waveform visualization** and **ReplayGain normalization**. Start with those, keep them optional, and be prepared to drop FFmpeg if stability becomes an issue.