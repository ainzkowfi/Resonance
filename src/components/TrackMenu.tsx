import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { useLibraryStore } from '../store/library';
import { font, palette, radius, shadow } from '../theme';
import type { Track } from '../types/track';
import { Touch } from './Touch';

interface MenuState {
  track: Track | null;
  open: (track: Track) => void;
  close: () => void;
}

const useMenuStore = create<MenuState>((set) => ({
  track: null,
  open: (track) => set({ track }),
  close: () => set({ track: null }),
}));

export function openTrackMenu(track: Track): void {
  useMenuStore.getState().open(track);
}

export function TrackMenu() {
  const track = useMenuStore((state) => state.track);
  const close = useMenuStore((state) => state.close);
  const hideTrack = useLibraryStore((state) => state.hideTrack);
  const deleteFile = useLibraryStore((state) => state.deleteFile);
  const setMetadata = useLibraryStore((state) => state.setMetadata);
  const playlists = useLibraryStore((state) => state.playlists);
  const createPlaylist = useLibraryStore((state) => state.createPlaylist);
  const addToPlaylist = useLibraryStore((state) => state.addToPlaylist);
  const [mode, setMode] = useState<'menu' | 'edit' | 'playlists' | 'new'>('menu');
  const insets = useSafeAreaInsets();

  const dismiss = () => {
    setMode('menu');
    close();
  };

  const remove = () => {
    if (!track) return;
    void hideTrack(track);
    dismiss();
  };

  const erase = () => {
    if (!track) return;
    Alert.alert('Delete file?', `${track.title} will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void deleteFile(track);
          dismiss();
        },
      },
    ]);
  };

  return (
    <Modal visible={track != null} transparent animationType="fade" onRequestClose={dismiss}>
      <Pressable style={styles.backdrop} onPress={dismiss} accessibilityLabel="Close menu" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetWrap}
        pointerEvents="box-none"
      >
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
          {mode === 'edit' && track ? (
            <EditForm
              track={track}
              onCancel={() => setMode('menu')}
              onSave={(patch) => {
                void setMetadata(track, patch);
                dismiss();
              }}
            />
          ) : mode === 'playlists' && track ? (
            <>
              <View style={styles.head}>
                <Text style={styles.title} numberOfLines={1}>
                  Add to playlist
                </Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {track.title}
                </Text>
              </View>
              <ScrollView style={styles.playlistScroll}>
                {playlists.map((playlist) => {
                  const added = playlist.uris.includes(track.uri);
                  return (
                    <Touch
                      key={playlist.id}
                      style={styles.row}
                      haptic="light"
                      accessibilityLabel={`Add to ${playlist.name}`}
                      onPress={() => {
                        if (!added) void addToPlaylist(playlist.id, track);
                        dismiss();
                      }}
                    >
                      <Ionicons
                        name={added ? 'checkmark-circle' : 'add-circle-outline'}
                        size={20}
                        color={added ? palette.accent : palette.textDim}
                      />
                      <Text style={[styles.rowLabel, styles.rowLabelGrow]} numberOfLines={1}>
                        {playlist.name}
                      </Text>
                      <Text style={styles.rowCount}>{playlist.uris.length}</Text>
                    </Touch>
                  );
                })}
                <Row icon="add" label="New playlist" onPress={() => setMode('new')} />
              </ScrollView>
              <Row icon="chevron-back" label="Back" onPress={() => setMode('menu')} />
            </>
          ) : mode === 'new' && track ? (
            <NewPlaylistForm
              onCancel={() => setMode('playlists')}
              onSave={(name) => {
                const id = createPlaylist(name);
                void addToPlaylist(id, track);
                dismiss();
              }}
            />
          ) : (
            <>
              <View style={styles.head}>
                <Text style={styles.title} numberOfLines={1}>
                  {track?.title}
                </Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {[track?.artist, track?.album].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Row icon="create-outline" label="Edit metadata" onPress={() => setMode('edit')} />
              <Row
                icon="add-circle-outline"
                label="Add to playlist"
                onPress={() => setMode('playlists')}
              />
              <Row icon="eye-off-outline" label="Hide from library" onPress={remove} />
              <Row icon="trash-outline" label="Delete file" onPress={erase} destructive />
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function NewPlaylistForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <View style={styles.form}>
      <Text style={styles.formTitle}>New playlist</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        style={styles.input}
        placeholder="Playlist name"
        placeholderTextColor={palette.textFaint}
        autoFocus
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={() => onSave(name)}
      />
      <View style={styles.formActions}>
        <Touch style={styles.formButton} onPress={onCancel}>
          <Text style={styles.formButtonText}>Cancel</Text>
        </Touch>
        <Touch style={[styles.formButton, styles.formButtonOn]} onPress={() => onSave(name)}>
          <Text style={[styles.formButtonText, styles.formButtonTextOn]}>Create</Text>
        </Touch>
      </View>
    </View>
  );
}

function EditForm({
  track,
  onCancel,
  onSave,
}: {
  track: Track;
  onCancel: () => void;
  onSave: (patch: { title: string; artist: string; album: string }) => void;
}) {
  const [draft, setDraft] = useState({
    title: track.title,
    artist: track.artist,
    album: track.album ?? '',
  });

  return (
    <View style={styles.form}>
      <Text style={styles.formTitle}>Edit metadata</Text>
      <Field label="Title" value={draft.title} onChangeText={(title) => setDraft({ ...draft, title })} />
      <Field
        label="Artist"
        value={draft.artist}
        onChangeText={(artist) => setDraft({ ...draft, artist })}
      />
      <Field label="Album" value={draft.album} onChangeText={(album) => setDraft({ ...draft, album })} />
      <View style={styles.formActions}>
        <Touch style={styles.formButton} onPress={onCancel}>
          <Text style={styles.formButtonText}>Cancel</Text>
        </Touch>
        <Touch
          style={[styles.formButton, styles.formButtonOn]}
          onPress={() =>
            onSave({
              title: draft.title.trim(),
              artist: draft.artist.trim(),
              album: draft.album.trim(),
            })
          }
        >
          <Text style={[styles.formButtonText, styles.formButtonTextOn]}>Save</Text>
        </Touch>
      </View>
    </View>
  );
}
function Row({
  icon,
  label,
  onPress,
  destructive,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Touch
      style={styles.row}
      onPress={onPress}
      haptic={destructive ? 'medium' : 'light'}
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={20} color={destructive ? palette.danger : palette.textDim} />
      <Text style={[styles.rowLabel, destructive && styles.rowLabelDanger]}>{label}</Text>
    </Touch>
  );
}

function Field({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        style={styles.input}
        placeholder={label}
        placeholderTextColor={palette.textFaint}
        autoCapitalize="words"
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: palette.scrim,
  },
  sheetWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    margin: 10,
    paddingTop: 6,
    borderRadius: radius.xl,
    backgroundColor: palette.surface,
    ...shadow.card,
  },
  head: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 2,
  },
  title: {
    ...font.body,
    fontSize: 16,
    color: palette.text,
  },
  subtitle: {
    ...font.label,
    fontWeight: '500',
    color: palette.textDim,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    minHeight: 52,
  },
  playlistScroll: {
    maxHeight: 340,
  },
  rowLabelGrow: {
    flex: 1,
  },
  rowCount: {
    ...font.label,
    color: palette.textFaint,
  },
  rowLabel: {
    ...font.body,
    fontSize: 15,
    color: palette.text,
  },
  rowLabelDanger: {
    color: palette.danger,
  },
  form: {
    padding: 18,
    gap: 12,
  },
  formTitle: {
    ...font.body,
    fontSize: 17,
    color: palette.text,
  },
  field: {
    gap: 4,
  },
  fieldLabel: {
    ...font.caption,
    color: palette.textFaint,
    paddingHorizontal: 2,
  },
  input: {
    ...font.body,
    fontSize: 15,
    color: palette.text,
    height: 44,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: palette.surfaceHi,
  },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 2,
  },
  formButton: {
    height: 40,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surfaceHi,
  },
  formButtonOn: {
    backgroundColor: palette.accent,
  },
  formButtonText: {
    ...font.label,
    fontWeight: '600',
    color: palette.text,
  },
  formButtonTextOn: {
    color: palette.bgElevated,
  },
});
