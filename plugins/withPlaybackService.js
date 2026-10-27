const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Declares the native playback service in the generated Android manifest.
 *
 * The service class is compiled inside the `expo` Android library, where the
 * inline-module mechanism puts every Kotlin file under the watched directories,
 * and an inline module cannot contribute manifest entries of its own. A config
 * plugin is the supported way to add them, and this project has no `android/`
 * directory to edit by hand.
 *
 * Both permissions are normal ones and are not prompted for at runtime. They
 * are mandatory from API 34 for a `mediaPlayback` foreground service, which is
 * how playback survives the app going to the background.
 */
const SERVICE_NAME = 'com.resonance.app.ResonancePlaybackService';

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
];

const withPlaybackService = (config) =>
  withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    manifest['uses-permission'] = manifest['uses-permission'] || [];
    for (const name of PERMISSIONS) {
      const declared = manifest['uses-permission'].some(
        (entry) => entry.$ && entry.$['android:name'] === name,
      );
      if (!declared) manifest['uses-permission'].push({ $: { 'android:name': name } });
    }

    const application = (manifest.application || [])[0];
    if (!application) {
      throw new Error('withPlaybackService: no <application> in the Android manifest');
    }

    application.service = application.service || [];
    const present = application.service.some(
      (entry) => entry.$ && entry.$['android:name'] === SERVICE_NAME,
    );
    if (!present) {
      application.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:exported': 'false',
          'android:foregroundServiceType': 'mediaPlayback',
        },
      });
    }

    return config;
  });

module.exports = withPlaybackService;
