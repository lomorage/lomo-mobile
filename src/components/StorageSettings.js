// Settings > Storage: what Lomorage keeps on this phone, a limit for the rebuildable cache, and a
// button to give that cache back. Shown for everyone, Lite mode included: people use Lomorage
// because their phone is full, so the app's own footprint has to be visible and controllable.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import StorageService, { CACHE_LIMIT_CHOICES_MB } from '../services/StorageService';
import { formatBytesLog } from '../utils/formatters';

const limitLabel = (mb) => (mb === 0 ? 'No limit' : mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`);
const size = (bytes) => formatBytesLog(bytes, { decimals: 1 });

export default function StorageSettings({ styles }) {
  const [usage, setUsage] = useState(null);
  const [limitMb, setLimitMb] = useState(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(async () => {
    const [u, l] = await Promise.all([
      StorageService.getUsage().catch(() => null),
      StorageService.getCacheLimitMb(),
    ]);
    setUsage(u);
    setLimitMb(l);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const chooseLimit = async (mb) => {
    setLimitMb(mb);
    await StorageService.setCacheLimitMb(mb);
    refresh();
  };

  const clear = () => {
    Alert.alert(
      'Clear cache?',
      'Removes thumbnails and other copies Lomorage keeps to load faster. Your photos, backups and favorites are not affected; thumbnails load again from your computer as you browse.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setClearing(true);
            try {
              await StorageService.clearCache();
            } finally {
              setClearing(false);
              refresh();
            }
          },
        },
      ],
    );
  };

  const rows = usage ? [
    ['Cache', usage.cache, 'Thumbnails, previews and temporary files. Safe to clear.'],
    ['Offline favorites', usage.favorites, 'Small previews of your favorites, for viewing without a connection.'],
    ['AI models', usage.models, 'Used for search and recognizing people.'],
    ['Library database', usage.database, 'Backup status and search data. Needed by the app.'],
  ] : [];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Storage on This Phone</Text>

      {usage === null ? (
        <ActivityIndicator style={{ marginVertical: 12 }} color="#007AFF" />
      ) : rows.map(([label, bytes, hint]) => (
        <View key={label} style={styles.settingRow}>
          <View style={styles.settingTextContainer}>
            <Text style={styles.settingLabel}>{label}</Text>
            <Text style={styles.settingDescription}>{hint}</Text>
          </View>
          <Text style={local.value}>{size(bytes)}</Text>
        </View>
      ))}

      <View style={[styles.settingRow, local.divider, { flexDirection: 'column', alignItems: 'flex-start' }]}>
        <Text style={styles.settingLabel}>Cache limit</Text>
        <Text style={styles.settingDescription}>
          Older copies are removed when the Lomorage cache grows past this.
        </Text>
        <View style={styles.albumSortRow}>
          {CACHE_LIMIT_CHOICES_MB.map((mb) => (
            <TouchableOpacity
              key={mb}
              onPress={() => chooseLimit(mb)}
              style={[styles.albumSortChip, limitMb === mb && styles.albumSortChipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: limitMb === mb }}
            >
              <Text style={[styles.albumSortChipText, limitMb === mb && styles.albumSortChipTextOn]}>
                {limitLabel(mb)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <TouchableOpacity
        style={[styles.settingRow, local.divider]}
        onPress={clear}
        disabled={clearing}
        accessibilityRole="button"
      >
        <View style={styles.settingTextContainer}>
          <Text style={[styles.settingLabel, local.action]}>{clearing ? 'Clearing…' : 'Clear cache'}</Text>
        </View>
        {clearing && <ActivityIndicator color="#007AFF" />}
      </TouchableOpacity>
    </View>
  );
}

const local = StyleSheet.create({
  value: { color: '#64748B', fontSize: 15, marginLeft: 12 },
  divider: { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 8 },
  action: { color: '#007AFF' },
});
