import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { font, HIT, palette } from '../theme';
import { Touch } from './Touch';

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  back?: boolean;
  action?: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void; label: string };
}

/** Consistent top bar for every screen. */
export function ScreenHeader({ title, subtitle, back, action }: ScreenHeaderProps) {
  const router = useRouter();

  return (
    <View style={styles.root}>
      {back ? (
        <Touch
          style={styles.iconButton}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-down" size={24} color={palette.text} />
        </Touch>
      ) : null}

      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {action ? (
        <Touch
          style={styles.iconButton}
          onPress={action.onPress}
          accessibilityLabel={action.label}
        >
          <Ionicons name={action.icon} size={22} color={palette.text} />
        </Touch>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    minHeight: 56,
  },
  titles: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...font.display,
    color: palette.text,
  },
  subtitle: {
    ...font.label,
    color: palette.textDim,
  },
  iconButton: {
    width: HIT.min,
    height: HIT.min,
    borderRadius: HIT.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
});
