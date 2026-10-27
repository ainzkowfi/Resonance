package com.resonance.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps the players alive when the app is not in front.
 *
 * The service owns nothing: the players and the media session live in
 * [ResonancePlayback], and this only has to exist so Android keeps the process
 * running and shows the notification. It is started when playback starts and
 * stopped when the session is cleared.
 *
 * The class is compiled into the `expo` Android library rather than the app, so
 * the manifest entry that names it — with the `mediaPlayback` foreground type
 * and its permission, both required from API 34 — is added by the config plugin
 * in `plugins/withPlaybackService.js`.
 */
class ResonancePlaybackService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Required within a few seconds of startForegroundService, so the
    // notification is built before anything else can fail.
    val notification = ResonancePlayback.notification(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        ResonancePlayback.NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      )
    } else {
      startForeground(ResonancePlayback.NOTIFICATION_ID, notification)
    }
    // Nothing to restart: without the players this service has no state.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    ResonancePlayback.onServiceStopped()
    super.onDestroy()
  }
}
