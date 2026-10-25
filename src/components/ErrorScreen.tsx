import { Ionicons } from '@expo/vector-icons';
import { Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { font, palette, radius } from '../theme';
import { Touch } from './Touch';

export interface ErrorScreenProps {
  title?: string;
  message: string;
  /** Stack trace, native output, component stack — anything worth copying. */
  detail?: string;
  hint?: string;
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/**
 * Last-resort screen.
 *
 * A hard crash closes the app with nothing to show, which makes bugs impossible
 * to report. This renders the message and the raw detail as selectable text and
 * offers a share sheet, so the whole report can be handed to an agent.
 */
export function ErrorScreen(props: ErrorScreenProps) {
  return (
    <SafeAreaProvider>
      <ErrorScreenBody {...props} />
    </SafeAreaProvider>
  );
}

function ErrorScreenBody({
  title = 'The app hit an error',
  message,
  detail,
  hint = 'Long-press the text below to copy it, or use Share to send it somewhere you can paste from.',
  onRetry,
  retryLabel = 'Try again',
  onDismiss,
  dismissLabel = 'Dismiss',
}: ErrorScreenProps) {
  const insets = useSafeAreaInsets();
  const report = detail ? `${message}\n\n${detail}` : message;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.badge}>
          <Ionicons name="warning-outline" size={26} color={palette.danger} />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text selectable style={styles.message}>
          {message}
        </Text>
        <Text style={styles.hint}>{hint}</Text>
        {detail ? (
          <View style={styles.detailBox}>
            <Text selectable style={styles.detail}>
              {detail}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Touch
          style={[styles.button, styles.buttonGhost]}
          haptic="none"
          onPress={() => {
            void Share.share({ message: report });
          }}
        >
          <Ionicons name="share-outline" size={17} color={palette.text} />
          <Text style={styles.buttonText}>Share error</Text>
        </Touch>

        {onDismiss ? (
          <Touch style={[styles.button, styles.buttonGhost]} haptic="none" onPress={onDismiss}>
            <Text style={styles.buttonText}>{dismissLabel}</Text>
          </Touch>
        ) : null}

        {onRetry ? (
          <Touch style={[styles.button, styles.buttonPrimary]} onPress={onRetry}>
            <Text style={[styles.buttonText, styles.buttonTextPrimary]}>{retryLabel}</Text>
          </Touch>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 12,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,140,154,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,140,154,0.32)',
    marginBottom: 4,
  },
  title: {
    ...font.title,
    color: palette.text,
  },
  message: {
    ...font.body,
    color: palette.textDim,
    lineHeight: 22,
  },
  hint: {
    ...font.label,
    fontWeight: '500',
    color: palette.textFaint,
    lineHeight: 18,
  },
  detailBox: {
    marginTop: 4,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
  },
  detail: {
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 16,
    color: palette.textDim,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  button: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 46,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
  },
  buttonGhost: {
    backgroundColor: palette.surfaceHi,
    borderWidth: 1,
    borderColor: palette.border,
  },
  buttonPrimary: {
    backgroundColor: palette.accent,
  },
  buttonText: {
    ...font.label,
    fontWeight: '700',
    fontSize: 13,
    color: palette.text,
  },
  buttonTextPrimary: {
    color: palette.bg,
  },
});
