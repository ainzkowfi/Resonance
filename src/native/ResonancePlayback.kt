package com.resonance.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Native playback: the players, the audio focus, and the lock screen surface.
 *
 * All of it runs on the main thread. `MediaPlayer` delivers its callbacks
 * through the looper of the thread that created it, and JavaScript does not run
 * on that thread, so every entry point hops there first — a player created on
 * the JS thread would either lose its callbacks or throw.
 *
 * One object for the whole process: the module is the bridge to JavaScript,
 * this holds the state, and the service that keeps playback alive in the
 * background builds its notification from the same state.
 *
 * Platform APIs are used deliberately instead of media3. An Expo inline module
 * is compiled inside the `expo` Android library, which does not depend on
 * media3, and an inline module cannot declare a Gradle dependency of its own —
 * so `MediaPlayer`, `MediaSession` and `Notification.MediaStyle` are the whole
 * toolbox here.
 */
internal object ResonancePlayback {
  const val NOTIFICATION_ID = 4311
  private const val TAG = "Resonance"
  private const val CHANNEL_ID = "resonance-playback"
  private const val CHANNEL_NAME = "Playback"
  private const val TICK_MS = 250L

  private const val ACTION_PLAY = "com.resonance.app.playback.PLAY"
  private const val ACTION_PAUSE = "com.resonance.app.playback.PAUSE"
  private const val ACTION_FORWARD = "com.resonance.app.playback.FORWARD"
  private const val ACTION_BACKWARD = "com.resonance.app.playback.BACKWARD"
  private const val ACTION_STOP = "com.resonance.app.playback.STOP"

  /**
   * Custom actions rather than `ACTION_FAST_FORWARD`: from Android 13 the
   * system builds the media controls out of `PlaybackState`, and the seek
   * increments media3 exposes are not part of the platform session API. A
   * custom action is the platform's own way to put "forward 30 s" on the lock
   * screen.
   */
  private const val CUSTOM_FORWARD = "com.resonance.app.playback.SEEK_FORWARD"
  private const val CUSTOM_BACKWARD = "com.resonance.app.playback.SEEK_BACKWARD"

  private val main = Handler(Looper.getMainLooper())

  private val audioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
    .build()

  private val holders = LinkedHashMap<String, Holder>()
  private var context: Context? = null
  private var session: MediaSession? = null
  private var receiver: BroadcastReceiver? = null
  private var tickerPosted = false
  private var serviceRunning = false
  private var focusHeld = false
  private var focusRequest: AudioFocusRequest? = null
  private var artwork: Bitmap? = null
  private var artworkKey: String? = null

  /** Set by the module; every status report goes through here to JavaScript. */
  var emitter: ((Map<String, Any?>) -> Unit)? = null

  /** Runs `block` on the main thread, immediately when already there. */
  fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  fun attach(appContext: Context) {
    context = appContext.applicationContext
  }

  // ----------------------------------------------------------------- players

  /**
   * Opens `path` as the player for `handle`.
   *
   * Returns as soon as the source has been handed to the decoder, not when it
   * is ready: the JavaScript engine already waits for a loaded status, and
   * blocking here would make a slow file look like a failed one.
   */
  fun open(handle: String, path: String) {
    val ctx = context ?: throw IllegalStateException("The playback module has no Android context")
    release(handle)

    val player = MediaPlayer()
    val holder = Holder(player)
    holders[handle] = holder

    try {
      player.setAudioAttributes(audioAttributes)
      player.setWakeMode(ctx, PowerManager.PARTIAL_WAKE_LOCK)
      if (path.startsWith("content://")) player.setDataSource(ctx, Uri.parse(path))
      else player.setDataSource(path)
    } catch (error: Exception) {
      holders.remove(handle)
      try {
        player.release()
      } catch (_: Exception) {
        // Nothing to release.
      }
      throw error
    }

    player.setOnPreparedListener {
      holder.loaded = true
      holder.buffering = false
      emitStatus()
      updateNotification()
    }
    player.setOnCompletionListener {
      // Reported once here and cleared by the next start or seek; the
      // JavaScript side edge-triggers it either way, because a finished player
      // keeps reporting it on every tick.
      holder.finished = true
      emitStatus()
      updateNotification()
    }
    player.setOnErrorListener { _, what, extra ->
      holder.error = "MediaPlayer error $what/$extra"
      holder.loaded = false
      holder.buffering = false
      emitStatus()
      true
    }
    player.setOnInfoListener { _, what, _ ->
      when (what) {
        MediaPlayer.MEDIA_INFO_BUFFERING_START -> holder.buffering = true
        MediaPlayer.MEDIA_INFO_BUFFERING_END -> holder.buffering = false
      }
      emitStatus()
      false
    }

    player.prepareAsync()
    ensureSession(ctx)
    ensureTicker()
  }

  fun play(handle: String) {
    val holder = holders[handle] ?: return
    holder.finished = false
    holder.error = null
    requestFocus()
    try {
      holder.player.start()
    } catch (error: Exception) {
      holder.error = error.message ?: "Could not start playback"
    }
    // The foreground service is what keeps the players alive once the app is
    // no longer in front; it stays up until the session is cleared.
    startService()
    emitStatus()
    updateNotification()
  }

  fun pause(handle: String) {
    val holder = holders[handle] ?: return
    try {
      holder.player.pause()
    } catch (_: Exception) {
      // Already stopped.
    }
    emitStatus()
    updateNotification()
  }

  fun seek(handle: String, seconds: Double) {
    val holder = holders[handle] ?: return
    if (!holder.loaded) {
      // A seek before the source is open is refused; the engine keeps the
      // position it asked for and applies it once a loaded status arrives.
      throw IllegalStateException("The player is not loaded yet")
    }
    val position = (seconds * 1000.0).toLong().coerceAtLeast(0L)
    val duration = safeDuration(holder).toLong()
    val target = if (duration > 0) position.coerceAtMost(duration) else position
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      holder.player.seekTo(target, MediaPlayer.SEEK_CLOSEST)
    } else {
      @Suppress("DEPRECATION")
      holder.player.seekTo(target.toInt())
    }
    holder.finished = false
    emitStatus()
    updateNotification()
  }

  fun setVolume(handle: String, volume: Float) {
    val holder = holders[handle] ?: return
    val level = volume.coerceIn(0f, 1f)
    try {
      holder.player.setVolume(level, level)
    } catch (_: Exception) {
      // The player is gone; release() cleans up.
    }
  }

  fun release(handle: String) {
    val holder = holders.remove(handle) ?: return
    try {
      holder.player.release()
    } catch (_: Exception) {
      // Already released.
    }

    if (holder.lockScreen) clearLockScreen()
    if (holders.isEmpty()) {
      abandonFocus()
      stopTicker()
      stopService()
    }
  }

  /**
   * Points the lock screen at `handle`.
   *
   * Only one player can be on the lock screen; publishing a second one would
   * mean the notification drives the track that is being faded out.
   */
  fun setLockScreen(
    handle: String,
    title: String,
    artist: String,
    album: String?,
    artworkUri: String?,
    forwardSeconds: Double,
    backwardSeconds: Double,
  ) {
    val holder = holders[handle] ?: return
    for (other in holders.values) {
      if (other !== holder) other.lockScreen = false
    }
    holder.lockScreen = true
    holder.title = title
    holder.artist = artist
    holder.album = album
    holder.forwardSeconds = forwardSeconds
    holder.backwardSeconds = backwardSeconds

    // Cleared by clearLockScreen when a session ends, so it is re-armed here
    // rather than only when the session is first created.
    session?.isActive = true

    if (artworkUri != null) loadArtwork(artworkUri)
    else {
      artwork = null
      artworkKey = null
    }

    updateSessionMetadata()
    ensureReceiver()
    updateNotification()
  }

  // ------------------------------------------------------------------ status

  /**
   * One status report per open player, at the engine's 4 Hz.
   *
   * A handle the engine is not using costs one small map. Filtering here would
   * mean the JavaScript side had to guess which player a report belongs to, and
   * a promoted preload changes which player that is.
   */
  private fun emitStatus() {
    val sink = emitter ?: return
    for ((handle, holder) in holders) {
      sink(
        mapOf(
          "handle" to handle,
          "currentTime" to safePosition(holder).toDouble() / 1000.0,
          "duration" to safeDuration(holder).toDouble() / 1000.0,
          "playing" to safePlaying(holder),
          "didJustFinish" to holder.finished,
          "isLoaded" to holder.loaded,
          "isBuffering" to holder.buffering,
          "error" to holder.error,
        ),
      )
    }
    updateSessionState()
  }

  private fun safePosition(holder: Holder): Int =
    try {
      if (holder.loaded) holder.player.currentPosition else 0
    } catch (_: Exception) {
      0
    }

  private fun safeDuration(holder: Holder): Int =
    try {
      if (holder.loaded) maxOf(0, holder.player.duration) else 0
    } catch (_: Exception) {
      0
    }

  private fun safePlaying(holder: Holder): Boolean =
    try {
      holder.loaded && holder.player.isPlaying
    } catch (_: Exception) {
      false
    }

  private val tick = object : Runnable {
    override fun run() {
      if (holders.isEmpty()) {
        tickerPosted = false
        return
      }
      emitStatus()
      main.postDelayed(this, TICK_MS)
    }
  }

  private fun ensureTicker() {
    if (tickerPosted) return
    tickerPosted = true
    main.postDelayed(tick, TICK_MS)
  }

  private fun stopTicker() {
    tickerPosted = false
    main.removeCallbacks(tick)
  }

  // ------------------------------------------------------------- audio focus

  /**
   * Focus is taken with `AUDIOFOCUS_GAIN` and lost with a pause, which is what
   * expo-audio's `doNotMix` did. Nothing resumes by itself: the app's own
   * watchdog reads the unexpected stop and tells the listener what happened, so
   * resuming here as well would fight it.
   */
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT ->
        activeHolder()?.let { pause(handleOf(it)) }
      else -> Unit
    }
  }

  private fun requestFocus() {
    if (focusHeld) return
    val ctx = context ?: return
    val manager = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(audioAttributes)
        .setOnAudioFocusChangeListener(focusListener)
        .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
    }
    focusHeld = granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() {
    if (!focusHeld) return
    val ctx = context ?: return
    val manager = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    val request = focusRequest
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null && request != null) {
      manager.abandonAudioFocusRequest(request)
    } else if (manager != null) {
      @Suppress("DEPRECATION")
      manager.abandonAudioFocus(focusListener)
    }
    focusHeld = false
  }

  // ------------------------------------------------------------ media session

  private fun ensureSession(ctx: Context) {
    if (session != null) return
    val created = MediaSession(ctx, "Resonance")
    created.setFlags(
      MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS,
    )
    created.setCallback(object : MediaSession.Callback() {
      override fun onPlay() {
        activeHolder()?.let { play(handleOf(it)) }
      }

      override fun onPause() {
        activeHolder()?.let { pause(handleOf(it)) }
      }

      override fun onStop() {
        activeHolder()?.let { pause(handleOf(it)) }
        clearLockScreen()
      }

      override fun onSeekTo(pos: Long) {
        activeHolder()?.let { seek(handleOf(it), pos.toDouble() / 1000.0) }
      }

      override fun onCustomAction(action: String, extras: Bundle?) {
        when (action) {
          CUSTOM_FORWARD -> seekBy(activeHolder(), forward = true)
          CUSTOM_BACKWARD -> seekBy(activeHolder(), forward = false)
          else -> Unit
        }
      }
    })
    created.isActive = true
    session = created
  }

  private fun seekBy(holder: Holder?, forward: Boolean) {
    if (holder == null || !holder.loaded) return
    val current = safePosition(holder).toDouble() / 1000.0
    val target = if (forward) current + holder.forwardSeconds else current - holder.backwardSeconds
    try {
      seek(handleOf(holder), target.coerceAtLeast(0.0))
    } catch (_: Exception) {
      // Raced with a reload; the next tick reports where it really is.
    }
  }

  private fun updateSessionMetadata() {
    val holder = activeHolder() ?: return
    val builder = MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, holder.title)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, holder.artist)
      .putLong(MediaMetadata.METADATA_KEY_DURATION, safeDuration(holder).toLong())
    holder.album?.let { builder.putString(MediaMetadata.METADATA_KEY_ALBUM, it) }
    artwork?.let { builder.putBitmap(MediaMetadata.METADATA_KEY_ART, it) }
    session?.setMetadata(builder.build())
  }

  /**
   * Rebuilt on every tick so the seek bar on the lock screen tracks the
   * position; `ACTION_SEEK_TO` is what makes the platform draw that bar at all.
   */
  private fun updateSessionState() {
    val active = session ?: return
    val holder = activeHolder()
    val playing = holder != null && safePlaying(holder)

    val builder = PlaybackState.Builder().setActions(
      PlaybackState.ACTION_PLAY or
        PlaybackState.ACTION_PAUSE or
        PlaybackState.ACTION_PLAY_PAUSE or
        PlaybackState.ACTION_STOP or
        PlaybackState.ACTION_SEEK_TO,
    )

    if (holder != null) {
      if (holder.backwardSeconds > 0) {
        builder.addCustomAction(
          PlaybackState.CustomAction.Builder(
            CUSTOM_BACKWARD,
            "Back ${holder.backwardSeconds.toInt()} s",
            android.R.drawable.ic_media_rew,
          ).build(),
        )
      }
      if (holder.forwardSeconds > 0) {
        builder.addCustomAction(
          PlaybackState.CustomAction.Builder(
            CUSTOM_FORWARD,
            "Forward ${holder.forwardSeconds.toInt()} s",
            android.R.drawable.ic_media_ff,
          ).build(),
        )
      }
    }

    val state = when {
      holder == null -> PlaybackState.STATE_NONE
      !holder.loaded -> PlaybackState.STATE_BUFFERING
      playing -> PlaybackState.STATE_PLAYING
      else -> PlaybackState.STATE_PAUSED
    }
    val position = if (holder != null) safePosition(holder).toLong() else 0L
    builder.setState(state, position, if (playing) 1f else 0f)
    active.setPlaybackState(builder.build())
  }

  // ------------------------------------------------------------- foreground

  private fun startService() {
    val ctx = context ?: return
    if (serviceRunning) return
    val intent = Intent(ctx, ResonancePlaybackService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
      else ctx.startService(intent)
      serviceRunning = true
    } catch (error: Exception) {
      // Android 12+ refuses a foreground service started from the background;
      // in-app playback still works, only the notification is missing.
      Log.w(TAG, "Could not start the playback service", error)
    }
  }

  private fun stopService() {
    val ctx = context ?: return
    if (serviceRunning) ctx.stopService(Intent(ctx, ResonancePlaybackService::class.java))
    serviceRunning = false
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    manager?.cancel(NOTIFICATION_ID)
  }

  /** The service reports its own death, so a killed service is not believed alive. */
  fun onServiceStopped() {
    serviceRunning = false
  }

  private fun clearLockScreen() {
    for (holder in holders.values) holder.lockScreen = false
    artwork = null
    artworkKey = null
    session?.setMetadata(MediaMetadata.Builder().build())
    session?.setPlaybackState(
      PlaybackState.Builder().setState(PlaybackState.STATE_NONE, 0L, 0f).build(),
    )
    session?.isActive = false
    stopService()
  }

  // ----------------------------------------------------------- notification

  fun notification(ctx: Context): Notification {
    val holder = activeHolder()
    val playing = holder != null && safePlaying(holder)
    ensureChannel(ctx)

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(ctx, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(ctx).setPriority(Notification.PRIORITY_LOW)
    }

    builder
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(holder?.title?.takeIf { it.isNotBlank() } ?: "Resonance")
      .setContentText(holder?.artist)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOnlyAlertOnce(true)
      .setOngoing(playing)
      .setShowWhen(false)

    artwork?.let { builder.setLargeIcon(it) }
    contentIntent(ctx)?.let { builder.setContentIntent(it) }

    val actions = mutableListOf<Notification.Action>()
    if (holder != null && holder.backwardSeconds > 0) {
      actions.add(
        Notification.Action.Builder(
          Icon.createWithResource(ctx, android.R.drawable.ic_media_rew),
          "Back ${holder.backwardSeconds.toInt()} s",
          command(ctx, ACTION_BACKWARD, 2),
        ).build(),
      )
    }
    actions.add(
      Notification.Action.Builder(
        Icon.createWithResource(
          ctx,
          if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
        ),
        if (playing) "Pause" else "Play",
        command(ctx, if (playing) ACTION_PAUSE else ACTION_PLAY, 1),
      ).build(),
    )
    if (holder != null && holder.forwardSeconds > 0) {
      actions.add(
        Notification.Action.Builder(
          Icon.createWithResource(ctx, android.R.drawable.ic_media_ff),
          "Forward ${holder.forwardSeconds.toInt()} s",
          command(ctx, ACTION_FORWARD, 3),
        ).build(),
      )
    }
    for (action in actions) builder.addAction(action)
    builder.setStyle(
      Notification.MediaStyle()
        .setMediaSession(session?.sessionToken)
        .setShowActionsInCompactView(*IntArray(actions.size) { it }),
    )
    return builder.build()
  }

  private fun updateNotification() {
    val ctx = context ?: return
    if (!serviceRunning) return
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    try {
      manager.notify(NOTIFICATION_ID, notification(ctx))
    } catch (error: Exception) {
      // The notification is a nicety; playback does not depend on it.
      Log.w(TAG, "Could not update the playback notification", error)
    }
  }

  private fun ensureChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW)
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  private fun contentIntent(ctx: Context): PendingIntent? {
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
    return PendingIntent.getActivity(
      ctx,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun command(ctx: Context, action: String, requestCode: Int): PendingIntent {
    val intent = Intent(action).setPackage(ctx.packageName)
    return PendingIntent.getBroadcast(
      ctx,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /**
   * Registered at runtime rather than in the generated manifest: the transport
   * buttons only have to work while something is playing, which is exactly as
   * long as this process is alive.
   */
  private fun ensureReceiver() {
    if (receiver != null) return
    val ctx = context ?: return
    val created = object : BroadcastReceiver() {
      override fun onReceive(from: Context?, intent: Intent?) {
        when (intent?.action) {
          ACTION_PLAY -> activeHolder()?.let { play(handleOf(it)) }
          ACTION_PAUSE -> activeHolder()?.let { pause(handleOf(it)) }
          ACTION_FORWARD -> seekBy(activeHolder(), forward = true)
          ACTION_BACKWARD -> seekBy(activeHolder(), forward = false)
          ACTION_STOP -> {
            activeHolder()?.let { pause(handleOf(it)) }
            clearLockScreen()
          }
        }
      }
    }
    val filter = IntentFilter().apply {
      addAction(ACTION_PLAY)
      addAction(ACTION_PAUSE)
      addAction(ACTION_FORWARD)
      addAction(ACTION_BACKWARD)
      addAction(ACTION_STOP)
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.registerReceiver(created, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        ctx.registerReceiver(created, filter)
      }
      receiver = created
    } catch (error: Exception) {
      Log.w(TAG, "Could not register the transport receiver", error)
    }
  }

  // ------------------------------------------------------------------ artwork

  /** Decoded off the main thread; the notification is updated when it lands. */
  private fun loadArtwork(uri: String) {
    if (uri == artworkKey) return
    artworkKey = uri
    artwork = null
    Thread {
      val bitmap = try {
        context?.contentResolver?.openInputStream(Uri.parse(uri))?.use {
          BitmapFactory.decodeStream(it)
        }
      } catch (_: Exception) {
        null
      }
      onMain {
        if (artworkKey == uri) {
          artwork = bitmap
          updateSessionMetadata()
          updateNotification()
        }
      }
    }.start()
  }

  // ------------------------------------------------------------------- lookup

  private fun activeHolder(): Holder? = holders.values.firstOrNull { it.lockScreen }

  private fun handleOf(holder: Holder): String =
    holders.entries.firstOrNull { it.value === holder }?.key ?: ""

  private class Holder(val player: MediaPlayer) {
    var loaded = false
    var buffering = false
    var finished = false
    var error: String? = null
    var lockScreen = false
    var title = ""
    var artist = ""
    var album: String? = null
    var forwardSeconds = 30.0
    var backwardSeconds = 15.0
  }
}
