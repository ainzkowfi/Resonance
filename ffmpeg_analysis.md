# FFmpeg feature plan (re-evaluated)

Last updated 2026‑10‑25, after the waveform pipeline shipped in `13bc27c`.
This supersedes the first pass in this file, which rated several features highly
that the bundled FFmpeg build cannot do at all.

---

## 1. What changed since the first analysis

| Fact | Evidence | Consequence |
| --- | --- | --- |
| The binary is an **LGPL build with a documented component list**, not a general-purpose FFmpeg | `node_modules/ffmpeg-expo/README.md` → "Default Codec Support" | Every feature must be checked against that list before it is planned |
| Filters included: `scale`, `trim`, `volume`, `fps`, `format`, `concat` (Android also `overlay`, `drawtext`) | same README | No `loudnorm`, `silenceremove`, `silencedetect`, `showwavespic`, `atempo`, `acrossfade`, `aformat`, `ebur128` |
| Encoders: AAC, MPEG‑4, PCM, MP4/MOV, Matroska/WebM, WAV/OGG; Android also GIF/PNG/MJPEG | same README | No MP3, FLAC, Opus, Vorbis or H.264/HEVC encoding → export is effectively AAC/M4A or WAV |
| Decoders are broad (MP3, AAC, FLAC, ALAC, Vorbis, Opus, WMA-ish AC3, PCM, MP4/MOV/MKV/OGG/WAV) | same README | Reading any library file for analysis is safe |
| The native module throws at **import** time when missing | `ffmpeg-expo/build/ExpoFFmpeg.js` (`requireNativeModule('ExpoFFmpeg')`) | Must stay behind the lazy, guarded import — this is what was force-closing the app |
| Android library files are SAF `content://` URIs | `src/library/local.ts` (`Directory.pickDirectoryAsync`) | Every job needs a copy into cache first; a 10 MB track costs a copy per analysis |
| A PCM decode path already exists and is cached per track | `src/ffmpeg/waveform.ts` (`-ac 1 -ar 8000 -t 900 -f wav`) | **Analysis is the cheap part.** Any measurement that is "just math over samples" no longer needs FFmpeg filters |
| `expo-audio` exposes `player.volume` (0–1) and `player.playbackRate` / `shouldCorrectPitch` | `node_modules/expo-audio/build/AudioModule.types.d.ts:94,122,126` | Volume leveling and speed control are native features; FFmpeg is the wrong tool for both |
| ReplayGain is already parsed but never applied | `src/lib/tags.ts:117,420,578` → `Track.gain`; `src/audio/engine.ts` never reads it | Leveling can start today for tagged files, with zero new dependencies |

---

## 2. Evaluation gates

A feature only survives if it clears all four:

1. **Binary gate** — the filter/codec it needs is in the documented list above.
2. **Need gate** — the app cannot already do it with data it has (tags, file bytes, native player APIs).
3. **Cost gate** — the work per track is bounded (≈ one decode plus small I/O), cancellable, and does not run in the background unasked.
4. **Exit gate** — the result has somewhere to go: playback state, the UI, or a file the user chose to write.

Anything that only clears the binary gate is "possible but pointless"; anything
that fails the binary gate is a false positive and is listed as dropped.

---

## 3. Re-evaluated matrix

Verdicts: **Ship** (next), **Later** (after the shipped path is validated), **Drop**, **No FFmpeg needed**.

| # | Feature | Original rating | Re-evaluated | Why |
| --- | --- | --- | --- | --- |
| 1 | Waveform display | High | **Ship — done** | Shipped on PCM + SVG. Remaining work is polish, not feasibility |
| 2 | Loudness leveling (was: `loudnorm`) | ★★★★☆ | **No FFmpeg needed → Ship** | `loudnorm`/`ebur128` are absent. Measure from the PCM we already decode, apply with `player.volume` |
| 3 | Skip leading/trailing silence (was: `silenceremove`) | ★★★★☆ | **No FFmpeg needed → Ship** | `silenceremove` absent, but silence bounds fall out of the same peak data. Playback-side seek, nothing destructive |
| 4 | Library pre-analysis (waveforms + levels) | rated ★★☆ (as "batch normalize") | **Ship, opt-in** | Only viable because analysis is now cheap and cacheable. Must be explicitly started, with progress and cancel |
| 5 | Clip / ringtone export | ★★★★☆ | **Later** | AAC+M4A encode and `-ss/-to` are supported on paper, but unverified binaries, a source copy per export, and nowhere to put the file without an extra picker step |
| 6 | Format conversion / transcode | ★★★★☆ | **Drop** | Output limited to AAC/M4A/WAV. Files that fail to play are already rare (platform decoders handle the scan set). No user problem to solve |
| 7 | Crossfade / gapless preparation | ★★★☆ | **Drop** | `acrossfade` absent; pre-rendering junctions means decode+encode per transition and a fragile handoff to `expo-audio` |
| 8 | Playback speed / pitch | ★★★☆ | **No FFmpeg needed → Later** | `playbackRate` + `shouldCorrectPitch` exist natively. A UI feature, unrelated to FFmpeg |
| 9 | Real-time EQ / effects | ★★☆ | **Drop** | No filters, and real-time processing is not what a CLI FFmpeg does well anyway |
| 10 | Stem separation / vocal removal | rated ★★☆ "later" | **Drop** | Needs ML models, minutes per track, GBs of weights |
| 11 | Metadata / artwork extraction fallback | ★★★★☆ | **Drop** | `src/lib/tags.ts` already parses ID3/FLAC/MP4/OGG/APE from raw bytes; FFmpeg adds nothing and cannot write back through SAF |
| 12 | Batch loudness normalization of the whole library | ★★★★☆ | **Drop as stated, folded into #4** | "Normalize everything" without asking is hours of I/O and battery. Becomes an analysis pass that makes playback quieter, not a rewrite of files |

Net result: of the six "high value" items in the first pass, **one is done, two
change shape and stay, one is deferred, and two were false positives**.

---

## 4. What ships next

### P0 — Capability probe (shipped in `a087bb8`)

The first waveform attempt failed because the plan trusted a README. Make the
device answer instead.

- `src/ffmpeg/probe.ts`: run `-hide_banner -filters`, `-encoders`, `-muxers`,
  `-decoders` through the already-guarded `run()` and store the combined output
  in the diagnostics log.
- Settings → Diagnostics gets a "Check FFmpeg capabilities" row; the result is
  copyable through the existing Share button.
- **Why first:** it converts every binary-gate question in this document from an
  assumption into a fact, for the actual build on the actual device.

### P1 — Loudness leveling, attenuation only (shipped)

**Design constraint found during re-evaluation:** `player.volume` is 0–1, so
gain can only go *down*. Track leveling therefore means "bring loud tracks down
to a common ceiling", not "make quiet ones louder" — the same behaviour as
Sound Check, and the honest thing to document in the UI.

- Extend the waveform cache file to `{ v: 2, peaks, rms, peak, lead, tail }`
  (unknown fields are ignored, so no cache invalidation needed if the version
  stays 1 and the fields are additive).
- Measurement: reuse the decoded PCM. Frame the samples at ~50 ms, drop frames
  below −50 dBFS, take the RMS of what remains, keep the true peak.
- Target: the **median** measured RMS (falls back to a fixed −16 dBFS below
  five samples). A median is used rather than a 95th percentile because with
  attenuation only, pulling the loudest tenth down to itself leaves every other
  jump untouched; the median halves the spread instead.
  `gainDb = target − measured`, clamped to `[−18, 0]`, then
  `volume = 10^(gainDb/20)`.
- Apply in `audioEngine.load()` next to the existing `bindStatus` call, so it
  survives track changes and does not fight user seeking.
- Tagged files can use `Track.gain` immediately, before analysis catches up.
- Toggle in Settings ("Volume leveling"), default off; the per-track dB value
  already shown in `track/[id]` stays truthful.
- **Verified offline:** six synthetic masters from −8 to −18 dBFS measure
  exactly (0.000 dB error), gains are all ≤ 0, volumes stay inside 0–1, and the
  library spread shrinks from 10 dB to 5 dB. Real music will not be that exact:
  the measure is RMS, not LUFS, so bass-heavy masters are trimmed slightly more
  than a true R128 meter would ask for.
- **Acceptance on device:** on a playlist mixing a −8 dBFS master with a
  −16 dBFS master, the jump at the track change is halved rather than removed,
  and no track clips.

### P2 — Skip leading/trailing silence (shipped)

- `lead` / `tail` come out of the same analysis: count leading/trailing bars
  below −45 dBFS, times the bar duration.
- Leading: `audioEngine.load(track, { startAt: max(resumePosition, lead) })` —
  the engine already accepts `startAt`.
- Trailing: when `position > duration − tail`, advance, instead of silence.
- Toggle in Settings, default off. Audiobooks and live rips are the audiences.
- **As shipped:** only gaps of 2 s or more are skipped (shorter ones are part of
  the music), a resume position past the intro is never undone, the track
  already playing is not jumped when the toggle is switched on mid-song, and
  both decisions are pure functions in `src/lib/silence.ts` with unit checks.
- **Acceptance:** a track with 4 s of lead silence starts audibly at 0:00; a
  track with a clean ending advances without a gap of silence.

### P3 — Waveform polish + opt-in library analysis (shipped)

- Cache version 3 stores **512** peaks instead of 96; the scrubber resamples to
  one bar every ~3 px (24–240 bars) at render time, so a layout change never
  costs a decode.
- "Analyze library" in Settings: a queue over unanalysed tracks, one native
  process at a time, progress bar with the current title, cancel, and a hard cap
  of 200 tracks per run. Nothing runs on launch; it is always an explicit tap.
- Cancel is cooperative: the track being decoded finishes (bounded by the 30 s
  timeout, typically 1–3 s) and the loop stops. State is token-guarded so a
  cancelled run can never overwrite a newer one.
- Counting "tracks analysed" is chunked through the event loop (250 cache probes
  per tick), because probing thousands of files synchronously would stall the
  screen that displays the number.
- Cache housekeeping: a run prunes `waveforms/` entries for tracks that left the
  library.
- **No battery gate:** adding `expo-battery` for a feature that only runs on
  demand was not worth another native dependency.
- **Acceptance:** 50 tracks analyse without a crash, the app stays responsive,
  and reopening the player is instant afterwards.

### P4 — Clip / ringtone export (~medium, gated)

Only after P0–P3 are validated on a real device.

- `-ss <start> -to <end> -i <src> -c:a aac -b:a 192k -movflags +faststart <out>.m4a`
  from a cached copy of the source.
- Output goes to a folder chosen with `Directory.pickDirectoryAsync()` (SAF), so
  no new dependency and no Android share-intent plumbing.
- UI: a range selector drawn on the waveform (`trim` numbers already exist in
  the peaks), "Save clip" in the track menu.
- **Known limitations to state in the UI:** no MP3 output in this build, and
  exports are re-encodes (quality loss on lossy sources).

---

## 5. Explicitly dropped, with evidence

| Feature | Gate failed | Evidence |
| --- | --- | --- |
| `loudnorm` / `ebur128` analysis | Binary | Filter list in the package README |
| `silenceremove` / `silencedetect` | Binary | Same |
| `showwavespic`, `aformat` | Binary | Same — this is why the first waveform attempt failed on both platforms |
| MP3 / FLAC / Opus export | Binary | Encoder list in the README |
| Crossfade, EQ, stem separation, upscaling | Binary + Cost | Filters absent; ml models out of scope for a local player |
| Real-time processing of any kind | Cost | A CLI process per buffer is the wrong architecture; the native player already owns the audio graph |
| Rewriting tags or replacing library files | Exit | SAF grants are read-mostly, and destructive writes to a user's library are a support nightmare |

---

## 6. Sequencing

```
P0 probe  ──▶  P1 leveling  ──▶  P2 silence  ──▶  P3 library pass  ──▶  P4 clips
 (facts)        (biggest UX      (cheap win,      (scales P1/P2,        (new surface,
                 win, no deps)    same data)       explicit consent)     gated on all)
```

Each step is independently shippable and each step's data feeds the next: the
analysis record added in P1 is what P2 and P3 read.

---

## 7. What to measure on device before trusting any of this

| Metric | Where | Target |
| --- | --- | --- |
| Decode time per track (3–5 min song) | `run()` `result.duration` | < 3 s |
| Peak memory during decode | Xcode/Android Studio profiler | < 40 MB above baseline |
| Cache size per track | `waveforms/*.json` | ≈ 2 KB |
| Crash-free rate over 20 consecutive tracks | manual | 20/20 |
| Waveform peaks line up with audible beats | eyeball | yes, before P1 is built |
| Leveling A/B | two known-loud/quiet tracks | no perceived jump |

---

## 8. Decisions needed

1. **Leveling target** — *settled during implementation:* adaptive median with a
   −16 dBFS fallback, so it works from the first track and improves as P3 adds
   measurements.
2. **Silence skipping** — separate toggle, or implied by "leveling" being on?
3. **Clip export** — is ringtone/clip creation actually wanted, or is P4 dead
   weight for a player that is otherwise read-only?
4. **Analysis consent** — is a manual "Analyze library" pass acceptable, or
   should it run the first time a track is played and just never in bulk?
