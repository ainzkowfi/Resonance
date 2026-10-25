import { type ErrorBoundaryProps, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { audioEngine } from '../audio/engine';
import { ErrorScreen } from '../components/ErrorScreen';
import { TrackMenu } from '../components/TrackMenu';
import { absorbCrashMarker } from '../ffmpeg/waveform';
import { installGlobalErrorHandler } from '../lib/errorHandler';
import { formatFatal, useDiagnosticsStore } from '../store/diagnostics';
import { palette } from '../theme';

/**
 * Shown by Expo Router when a screen throws while rendering. Without it, a
 * release build closes and the report is lost.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <ErrorScreen
      title="This screen crashed"
      message={error?.message || 'Unknown error'}
      detail={[error?.stack, `${Platform.OS} ${String(Platform.Version)}`]
        .filter(Boolean)
        .join('\n\n')}
      onRetry={() => void retry()}
      retryLabel="Reload screen"
    />
  );
}

export default function RootLayout() {
  const fatal = useDiagnosticsStore((state) => state.fatal);
  const clearFatal = useDiagnosticsStore((state) => state.clearFatal);

  // Configure audio focus and background playback as early as possible.
  useEffect(() => {
    void audioEngine.configure();
    // A leftover marker means the last waveform run killed the process.
    void absorbCrashMarker();
  }, []);

  useEffect(() => installGlobalErrorHandler(), []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: palette.bg },
            animation: 'fade',
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="queue"
            options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="hidden"
            options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="excluded"
            options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
          />
          <Stack.Screen name="track/[id]" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="playlist/[id]" options={{ animation: 'slide_from_right' }} />
        </Stack>
        <TrackMenu />
        {fatal ? (
          <View style={styles.overlay}>
            <ErrorScreen
              title="Something broke"
              message={fatal.message}
              detail={formatFatal(fatal)}
              onDismiss={clearFatal}
              dismissLabel="Keep using the app"
            />
          </View>
        ) : null}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 100,
  },
});
