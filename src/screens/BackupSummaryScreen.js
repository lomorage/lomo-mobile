import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { ShieldCheck, ChevronLeft } from 'lucide-react-native';
import AssetDBService from '../services/AssetDBService';
import BackupSafetyService, { UNSAFE_REASONS } from '../services/BackupSafetyService';
import { describeCounts, summarizeBackup, summarizeVerification } from '../utils/backupSummary';
import { formatBytesLog } from '../utils/formatters';
import { logSincePairedOnce } from '../utils/scaleMetrics';

const CANNOT_CHECK = new Set([UNSAFE_REASONS.SERVER_UNREACHABLE, UNSAFE_REASONS.STORAGE_UNAVAILABLE]);

/**
 * "Are my photos safe?" -- checks every backed-up item on this phone against the
 * Lomorage computer and says how much space can be freed. Shown after the first backup
 * and from Settings.
 */
export default function BackupSummaryScreen({ navigation }) {
    const [progress, setProgress] = useState(null); // { done, total } while checking
    const [result, setResult] = useState(null);
    const [unreachable, setUnreachable] = useState(false);
    const mounted = useRef(true);

    const check = useCallback(async () => {
        setResult(null);
        setUnreachable(false);
        setProgress({ done: 0, total: 0 });
        try {
            const [videos, photos, summaryRows] = await Promise.all([
                AssetDBService.getFreeUpSpaceCandidates('video'),
                AssetDBService.getFreeUpSpaceCandidates('photo'),
                AssetDBService.getBackupSummaryRows(),
            ]);
            const items = [...photos, ...videos].map(asset => ({ ...asset, sizeBytes: asset.fileSize || 0 }));
            if (mounted.current) setProgress({ done: 0, total: items.length });

            const verification = await BackupSafetyService.checkAll(items.map(item => item.id), (done, total) => {
                if (mounted.current) setProgress({ done, total });
            });
            if (!mounted.current) return;

            const nothingCheckable = items.length > 0 && verification.safe.length === 0
                && verification.unsafe.every(({ reason }) => CANNOT_CHECK.has(reason));
            setUnreachable(nothingCheckable);
            const backup = summarizeBackup(summaryRows);
            const summary = {
                ...summarizeVerification(items, verification),
                notBackedUp: backup.notBackedUp,
                skipped: backup.skipped,
            };
            setResult(summary);
            if (summary.safeCount > 0 && summary.unconfirmedCount === 0 && summary.notBackedUp === 0) {
                // Time to Safe: pairing -> everything on the phone confirmed safe at home.
                logSincePairedOnce('time_to_safe', {
                    photos: summary.safePhotos, videos: summary.safeVideos, bytes: summary.safeBytes,
                });
            }
        } catch (e) {
            console.error('[BackupSummaryScreen] Check failed:', e);
            if (mounted.current) setUnreachable(true);
        } finally {
            if (mounted.current) setProgress(null);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        check();
        return () => { mounted.current = false; };
    }, [check]);

    const formatSize = (bytes) => formatBytesLog(bytes, { decimals: 1 });

    let body;
    if (progress) {
        body = (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.progressText}>
                    {progress.total > 0
                        ? `Checking with your Lomorage computer… ${progress.done.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')}`
                        : 'Checking with your Lomorage computer…'}
                </Text>
            </View>
        );
    } else if (unreachable) {
        body = (
            <View style={styles.centered}>
                <Text style={styles.title}>{"Couldn't reach your Lomorage computer"}</Text>
                <Text style={styles.detail}>{"Make sure it's on and this phone is on the same Wi-Fi, then try again. Nothing was changed."}</Text>
                <TouchableOpacity style={styles.primaryButton} onPress={check}>
                    <Text style={styles.primaryButtonText}>Try Again</Text>
                </TouchableOpacity>
            </View>
        );
    } else if (result) {
        const allSafe = result.safeCount > 0 && result.unconfirmedCount === 0 && result.notBackedUp === 0;
        body = (
            <View style={styles.centered}>
                <View style={styles.iconCircle}>
                    <ShieldCheck size={48} color="#34C759" />
                </View>
                <Text style={styles.title}>
                    {result.safeCount === 0
                        ? 'Nothing is backed up yet'
                        : allSafe ? 'Your photos are safe at home' : 'Most of your photos are safe at home'}
                </Text>
                {result.safeCount > 0 && (
                    <>
                        <Text style={styles.bigNumber}>{describeCounts(result.safePhotos, result.safeVideos)}</Text>
                        <Text style={styles.detail}>
                            {result.weakEvidence ? 'backed up to your Lomorage computer' : 'checked and safe on your Lomorage computer'}
                        </Text>
                        {result.safeBytes > 0 && (
                            <Text style={styles.freeable}>
                                {result.sizeIsPartial ? 'At least ' : ''}{formatSize(result.safeBytes)} can be freed from this phone
                            </Text>
                        )}
                    </>
                )}
                {result.notBackedUp > 0 && (
                    <Text style={styles.note}>
                        {result.notBackedUp.toLocaleString('en-US')} still to back up — they stay on this phone until then.
                    </Text>
                )}
                {result.skipped > 0 && (
                    <Text style={styles.note}>
                        {`${result.skipped.toLocaleString('en-US')} in albums you don't back up — they stay on this phone.`}
                    </Text>
                )}
                {result.unconfirmedCount > 0 && (
                    <Text style={styles.note}>
                        {`${result.unconfirmedCount.toLocaleString('en-US')} couldn't be confirmed — they stay on this phone.`}
                    </Text>
                )}
                {result.weakEvidence && (
                    <Text style={styles.note}>{"Your Lomorage computer is running an older version; updating it lets us confirm each file."}</Text>
                )}
                {result.safeCount > 0 && (
                    <TouchableOpacity style={styles.primaryButton} onPress={() => navigation.replace('FreeUpSpace')}>
                        <Text style={styles.primaryButtonText}>Free Up Space</Text>
                    </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.goBack()}>
                    <Text style={styles.secondaryButtonText}>Done</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                    <ChevronLeft size={28} color="#007AFF" />
                    <Text style={styles.backText}>Back</Text>
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Backup Status</Text>
            </View>
            {body}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 15,
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        position: 'absolute',
        bottom: 10,
        left: 0,
        zIndex: 10,
    },
    backText: {
        color: '#007AFF',
        fontSize: 17,
    },
    headerTitle: {
        flex: 1,
        textAlign: 'center',
        fontSize: 17,
        fontWeight: '600',
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    iconCircle: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: '#eafaf0',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 20,
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        color: '#1a1a1a',
        textAlign: 'center',
        marginBottom: 12,
    },
    bigNumber: {
        fontSize: 20,
        fontWeight: '600',
        color: '#1a1a1a',
        textAlign: 'center',
    },
    detail: {
        fontSize: 15,
        color: '#666',
        textAlign: 'center',
        marginTop: 4,
    },
    freeable: {
        fontSize: 18,
        fontWeight: '600',
        color: '#007AFF',
        textAlign: 'center',
        marginTop: 16,
    },
    note: {
        fontSize: 14,
        color: '#888',
        textAlign: 'center',
        marginTop: 10,
    },
    progressText: {
        marginTop: 12,
        color: '#666',
        textAlign: 'center',
    },
    primaryButton: {
        marginTop: 28,
        backgroundColor: '#007AFF',
        borderRadius: 24,
        paddingVertical: 14,
        paddingHorizontal: 40,
    },
    primaryButtonText: {
        color: '#fff',
        fontSize: 17,
        fontWeight: '600',
    },
    secondaryButton: {
        marginTop: 12,
        paddingVertical: 10,
        paddingHorizontal: 40,
    },
    secondaryButtonText: {
        color: '#007AFF',
        fontSize: 16,
    },
});
