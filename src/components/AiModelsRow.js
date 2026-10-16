import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import ModelAssetService from '../services/ModelAssetService';
import { formatBytesLog } from '../utils/formatters';

// Settings row for the on-demand AI models: size before download, live progress, retry.
export default function AiModelsRow({ style }) {
    const [ready, setReady] = useState(null); // null until the first disk check finishes
    const [dl, setDl] = useState(ModelAssetService.getState());

    useEffect(() => {
        let alive = true;
        ModelAssetService.isReady().then((r) => alive && setReady(r)).catch(() => alive && setReady(false));
        const unsubscribe = ModelAssetService.subscribe((next) => {
            if (!alive) return;
            setDl(next);
            if (next.status === 'ready') setReady(true);
        });
        return () => {
            alive = false;
            unsubscribe();
        };
    }, []);

    if (ready === null) return null;

    const download = () => ModelAssetService.ensureModels().catch(() => {});
    const downloading = dl.status === 'downloading';
    const total = ModelAssetService.getTotalBytes();

    let description;
    if (downloading) {
        const pct = dl.totalBytes ? Math.floor((dl.downloadedBytes / dl.totalBytes) * 100) : 0;
        description = `Downloading… ${pct}% (${formatBytesLog(dl.downloadedBytes, { decimals: 0 })} of ${formatBytesLog(dl.totalBytes, { decimals: 0 })})`;
    } else if (ready) {
        description = 'Downloaded. Runs on this phone, no internet needed.';
    } else if (dl.status === 'error') {
        description = `Download failed. Check your connection and try again. (${dl.error})`;
    } else {
        description = `One-time download of about ${formatBytesLog(total, { decimals: 0 })}, needed for search and faces. Wi-Fi recommended.`;
    }

    return (
        <View style={style}>
            <View style={styles.text}>
                <Text style={styles.label}>AI Models</Text>
                <Text style={styles.description}>{description}</Text>
            </View>
            {!ready && !downloading && (
                <TouchableOpacity style={styles.button} onPress={download} accessibilityRole="button">
                    <Text style={styles.buttonText}>{dl.status === 'error' ? 'Retry' : 'Download'}</Text>
                </TouchableOpacity>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    text: { flex: 1, marginRight: 20 },
    label: { fontSize: 16, color: '#333', fontWeight: '500' },
    description: { fontSize: 13, color: '#888', marginTop: 4, lineHeight: 18 },
    button: { backgroundColor: '#007AFF', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
    buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
