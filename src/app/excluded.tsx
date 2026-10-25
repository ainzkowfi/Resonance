import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '../components/ScreenHeader';
import { Touch } from '../components/Touch';
import { folderLabel, folderPath } from '../lib/folderExclusions';
import { useLibraryStore } from '../store/library';
import { font, palette, radius } from '../theme';

/**
 * Folders left out of a folder scan.
 *
 * Exclusion happens while walking the tree, so an excluded folder costs one
 * directory listing and nothing else: none of the files inside it are read for
 * tags, none are cached, and any that were already listed disappear on the
 * rescan that follows a change.
 */
export default function ExcludedFoldersScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const excluded = useLibraryStore((state) => state.excludedFolders);
  const folder = useLibraryStore((state) => state.folder);
  const scanning = useLibraryStore((state) => state.scanning);
  const pickExcludedFolder = useLibraryStore((state) => state.pickExcludedFolder);
  const includeFolderAgain = useLibraryStore((state) => state.includeFolderAgain);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Excluded folders"
        subtitle={
          scanning
            ? 'Rescanning…'
            : excluded.length === 0
              ? 'Nothing skipped'
              : `${excluded.length} skipped`
        }
        back
      />

      <Touch
        style={[styles.addRow, scanning && styles.disabled]}
        disabled={scanning}
        onPress={() => void pickExcludedFolder()}
        accessibilityLabel="Exclude a folder"
      >
        <View style={styles.addIcon}>
          <Ionicons name="add" size={18} color={palette.accent} />
        </View>
        <View style={styles.addText}>
          <Text style={styles.addTitle}>Exclude a folder</Text>
          <Text style={styles.addHint}>
            {folder
              ? 'Pick a folder inside your music folder to leave it out'
              : 'Applies once you scan a folder rather than the media library'}
          </Text>
        </View>
        {scanning ? <ActivityIndicator size="small" color={palette.textFaint} /> : null}
      </Touch>

      {excluded.length === 0 ? (
        <Animated.View entering={FadeIn.duration(220)} style={styles.empty}>
          <Text style={styles.emptyTitle}>Every folder is scanned</Text>
          <Text style={styles.emptyBody}>
            Exclude a folder to skip it and everything inside it. The files stay on your
            device — they just stop appearing in the library.
          </Text>
        </Animated.View>
      ) : (
        <FlatList
          data={excluded}
          keyExtractor={(item) => item}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Ionicons name="folder-outline" size={20} color={palette.textFaint} />
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {folderLabel(item)}
                </Text>
                <Text style={styles.rowPath} numberOfLines={1}>
                  {folderPath(item)}
                </Text>
              </View>
              <Touch
                style={[styles.include, scanning && styles.disabled]}
                disabled={scanning}
                onPress={() => void includeFolderAgain(item)}
                accessibilityLabel={`Scan ${folderLabel(item)} again`}
              >
                <Text style={styles.includeText}>Include</Text>
              </Touch>
            </View>
          )}
        />
      )}

      <Touch style={[styles.close, { bottom: insets.bottom + 16 }]} onPress={() => router.back()}>
        <Text style={styles.closeText}>Done</Text>
      </Touch>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
  },
  addIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.selectionStrong,
  },
  addText: {
    flex: 1,
    gap: 2,
  },
  addTitle: {
    ...font.body,
    color: palette.text,
  },
  addHint: {
    ...font.caption,
    fontWeight: '500',
    letterSpacing: 0,
    color: palette.textFaint,
  },
  disabled: {
    opacity: 0.5,
  },
  list: {
    paddingTop: 8,
    paddingBottom: 120,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    minHeight: 60,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...font.body,
    color: palette.text,
  },
  rowPath: {
    ...font.caption,
    fontWeight: '500',
    letterSpacing: 0,
    color: palette.textFaint,
  },
  include: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.selectionStrong,
  },
  includeText: {
    ...font.label,
    fontWeight: '600',
    color: palette.accent,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 6,
  },
  emptyTitle: {
    ...font.body,
    fontSize: 17,
    color: palette.text,
  },
  emptyBody: {
    ...font.label,
    fontWeight: '500',
    color: palette.textDim,
    textAlign: 'center',
  },
  close: {
    position: 'absolute',
    alignSelf: 'center',
    height: 44,
    paddingHorizontal: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.text,
  },
  closeText: {
    ...font.label,
    fontWeight: '600',
    color: palette.bgElevated,
  },
});
