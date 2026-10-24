import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import type { BottomTabBarProps } from 'expo-router/js-tabs';

import { font, motion, palette, radius } from '../theme';
import { Glass } from './Glass';
import { Touch } from './Touch';

export const TAB_ROW_HEIGHT = 58;

const PILL_WIDTH = 48;

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'musical-notes',
  search: 'search',
  settings: 'settings',
};

/**
 * Custom tab bar: a pill slides between tabs and the active icon lifts.
 *
 * The navigator hands us the routes and a `navigateToTab` callback, so the bar
 * only has to render and animate.
 */
export function TabBar({ state, descriptors, navigateToTab, insets }: BottomTabBarProps) {
  const routes = state.routes;
  const focusedIndex = state.index;
  const [rowWidth, setRowWidth] = useState(0);

  const tabWidth = rowWidth / Math.max(1, routes.length);
  const pillX = useSharedValue(0);
  const pillWidth = useSharedValue(0);

  useEffect(() => {
    if (tabWidth <= 0) return;
    const width = Math.round(tabWidth * 0.8);
    pillWidth.value = withSpring(width, motion.spring.snappy);
    pillX.value = withSpring(focusedIndex * tabWidth + (tabWidth - width) / 2, motion.spring.snappy);
  }, [focusedIndex, tabWidth, pillX, pillWidth]);

  const pillStyle = useAnimatedStyle(() => ({
    width: pillWidth.value,
    transform: [{ translateX: pillX.value }],
  }));

  return (
    <Glass style={styles.root}>
      <View
        style={[
          styles.row,
          { height: TAB_ROW_HEIGHT + insets.bottom, paddingBottom: insets.bottom },
        ]}
        onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
      >
        <Animated.View style={[styles.pill, pillStyle]} />
        {routes.map((route, index) => {
          const options = descriptors[route.key]?.options;
          const focused = index === focusedIndex;
          const label =
            typeof options?.title === 'string' ? options.title : route.name;
          return (
            <TabItem
              key={route.key}
              icon={ICONS[route.name] ?? 'ellipse'}
              label={label}
              focused={focused}
              onPress={() => {
                if (!focused) navigateToTab(route.key);
              }}
            />
          );
        })}
      </View>
    </Glass>
  );
}

function TabItem({
  icon,
  label,
  focused,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  focused: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withSpring(focused ? 1.14 : 1, motion.spring.snappy);
  }, [focused, scale]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Touch style={styles.item} onPress={onPress} haptic="none" accessibilityLabel={label}>
      <Animated.View style={[styles.iconWrap, iconStyle]}>
        <Ionicons
          name={icon}
          size={22}
          color={focused ? palette.accent : palette.textFaint}
        />
      </Animated.View>
      <Text style={[styles.label, focused ? styles.labelActive : styles.labelIdle]}>{label}</Text>
    </Touch>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  item: {
    flex: 1,
    height: TAB_ROW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  iconWrap: {
    width: PILL_WIDTH,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    position: 'absolute',
    left: 0,
    top: 6,
    height: 46,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(107,78,255,0.12)',
  },
  label: {
    ...font.caption,
    letterSpacing: 0.2,
  },
  labelActive: {
    color: palette.accent,
  },
  labelIdle: {
    color: palette.textFaint,
  },
});
