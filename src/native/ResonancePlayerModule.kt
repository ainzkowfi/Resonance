package com.resonance.app

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The bridge between the JavaScript engine and [ResonancePlayback].
 *
 * A handle is a string the JavaScript side chooses; this module never inspects
 * one. Every call is moved onto the main thread, because that is where
 * `MediaPlayer` has to be driven from — see [ResonancePlayback].
 *
 * The file name is not free: Expo's inline-module scanner derives the module
 * name from it, and a mismatch against the class it finds there would not
 * compile. Keep it `ResonancePlayerModule` and keep `definition()` written as
 * `override fun definition() = ModuleDefinition {`, which is the shape the
 * scanner looks for.
 */
class ResonancePlayerModule : Module() {
  override fun definition() = ModuleDefinition {
    Events("onPlaybackStatus")

    OnCreate {
      ResonancePlayback.emitter = { payload -> sendEvent("onPlaybackStatus", payload) }
    }

    AsyncFunction("configure") { promise: Promise ->
      if (attachContext() == null) {
        promise.reject("ERR_AUDIO_CONTEXT", "No Android context for playback", null)
      } else {
        promise.resolve(true)
      }
    }

    AsyncFunction("create") { handle: String, path: String, promise: Promise ->
      val context = attachContext()
      if (context == null) {
        promise.reject("ERR_AUDIO_CONTEXT", "No Android context for playback", null)
      } else {
        ResonancePlayback.onMain {
          try {
            ResonancePlayback.open(handle, path)
            promise.resolve(true)
          } catch (error: Exception) {
            promise.reject("ERR_AUDIO_OPEN", error.message ?: "Could not open the file", error)
          }
        }
      }
    }

    AsyncFunction("replace") { handle: String, path: String, promise: Promise ->
      val context = attachContext()
      if (context == null) {
        promise.reject("ERR_AUDIO_CONTEXT", "No Android context for playback", null)
      } else {
        ResonancePlayback.onMain {
          try {
            ResonancePlayback.open(handle, path)
            promise.resolve(true)
          } catch (error: Exception) {
            promise.reject("ERR_AUDIO_OPEN", error.message ?: "Could not open the file", error)
          }
        }
      }
    }

    AsyncFunction("seek") { handle: String, seconds: Double, promise: Promise ->
      ResonancePlayback.onMain {
        try {
          ResonancePlayback.seek(handle, seconds)
          promise.resolve(true)
        } catch (error: Exception) {
          promise.reject("ERR_AUDIO_SEEK", error.message ?: "Could not seek", error)
        }
      }
    }

    Function("play") { handle: String ->
      ResonancePlayback.onMain { ResonancePlayback.play(handle) }
    }

    Function("pause") { handle: String ->
      ResonancePlayback.onMain { ResonancePlayback.pause(handle) }
    }

    Function("setVolume") { handle: String, volume: Double ->
      ResonancePlayback.onMain { ResonancePlayback.setVolume(handle, volume.toFloat()) }
    }

    Function("release") { handle: String ->
      ResonancePlayback.onMain { ResonancePlayback.release(handle) }
    }

    Function("setLockScreen") { handle: String, title: String, artist: String, album: String?, artworkUri: String?, forwardSeconds: Double, backwardSeconds: Double ->
      ResonancePlayback.onMain {
        ResonancePlayback.setLockScreen(
          handle = handle,
          title = title,
          artist = artist,
          album = album,
          artworkUri = artworkUri,
          forwardSeconds = forwardSeconds,
          backwardSeconds = backwardSeconds,
        )
      }
    }
  }

  /**
   * The React context is not guaranteed to exist when the module is created, so
   * it is taken on each call rather than once in `OnCreate`.
   */
  private fun attachContext(): Context? {
    val context = appContext.reactContext?.applicationContext ?: return null
    ResonancePlayback.attach(context)
    return context
  }
}
