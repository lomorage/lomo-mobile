import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { ShieldCheck, ChevronLeft } from 'lucide-react-native';
import AssetDBService from '../services/AssetDBService';
import BackupSafetyService, { UNSAFE_REASONS } from '../services/BackupSafetyService';
import SyncService from '../services/SyncService';
import AuthService from '../services/AuthService';
import { getLastBackupAt } from '../services/backupHistory';
import { describeCounts, describeWhen, summarizeBackup, summarizeVerification } from '../utils/backupSummary';
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
            const [videos, photos, summaryRows, atHomeBefore, lastBackupAt] = await Promise.all([
                AssetDBService.getFreeUpSpaceCandidates('video'),
                AssetDBService.getFreeUpSpaceCandidates('photo'),
                AssetDBService.getBackupSummaryRows(),
                AssetDBService.getAtHomeCounts(),
                getLastBackupAt(),
            ]);
            const items = [...photos, ...videos].map(asset => ({ ...asset, sizeBytes: asset.fileSize || 0 }));
            if (mounted.current) setProgress({ done: 0, total: items.length });

            const verification = await BackupSafetyService.checkAll(items.map(item => item.id), (done, total) => {
                if (mounted.current) setProgress({ done, total });
            });
            if (!mounted.current) return;

            const nothingCheckable = items.length > 0 && verification.safe.length === 0
                && verification.unsafe.every(({ reason }) => CANNOT_CHECK.has(reason));
            if (nothingCheckable) {
                setUnreachable(true);
                return;
            }

            // Nothing left on the phone means the check above asked the computer nothing, so the
            // freed photos would rest on this phone's records alone, and those outlive the
            // computer going offline or dropping them. The backup's own Merkle sync is that
            // question already answered: it compares the computer's tree with the mirror and
            // drops the rows the computer no longer lists, normally in one request.
            let atHome = atHomeBefore;
            let atHomeLost = 0;
            if (items.length === 0) {
                try {
                    await SyncService.fetchRemoteOverview();
                } catch (e) {
                    console.warn('[BackupSummaryScreen] Could not ask the computer what it holds:', e.message);
                    if (mounted.current) setUnreachable(true);
                    return;
                }
                if (!mounted.current) return;
                atHome = await AssetDBService.getAtHomeCounts();
                if (!mounted.current) return;
                // The refresh pruned rows the computer no longer lists: those files are gone
                // from it, and gone from this phone too.
                const before = (atHomeBefore?.photos || 0) + (atHomeBefore?.videos || 0);
                atHomeLost = Math.max(0, before - ((atHome?.photos || 0) + (atHome?.videos || 0)));
            }
            const backup = summarizeBackup(summaryRows);
            const summary = {
                ...summarizeVerification(items, verification),
                notBackedUp: backup.notBackedUp,
                skipped: backup.skipped,
                // What the computer listed just now for the photos freed from this phone: the
                // check above only covers what is still on the phone.
                atHomePhotos: atHome?.photos || 0,
                atHomeVideos: atHome?.videos || 0,
                atHomeLost,
                computerName: AuthService.getServerName?.() || null,
                lastBackupAt,
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

    // Where the originals are on the computer; a hint, so a failed lookup just shows nothing.
    const [originalsPath, setOriginalsPath] = useState(null);
    useEffect(() => {
        let live = true;
        Promise.resolve(AuthService.getOriginalsLocation?.()).then((p) => { if (live) setOriginalsPath(p || null); }).catch(() => {});
        return () => { live = false; };
    }, []);

    useEffect(() => {
        mounted.current = true;
        check();
        // A file the computer had lost was just put back: check again so it shows as safe.
        const unsubscribe = BackupSafetyService.onRestored(() => {
            if (mounted.current) check();
        });
        return () => {
            mounted.current = false;
            unsubscribe();
        };
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
        // Nothing left on the phone to check is not "nothing backed up": after freeing space the
        // photos are on the computer only.
        const atHomeCount = result.atHomePhotos + result.atHomeVideos;
        const onlyAtHome = result.safeCount === 0 && atHomeCount > 0 && result.unconfirmedCount === 0;
        // The computer listed none of what this phone freed, so there is no count to show.
        const allAtHomeLost = atHomeCount === 0 && result.safeCount === 0 && result.atHomeLost > 0;
        const allSafe = (result.safeCount > 0 || onlyAtHome) && result.unconfirmedCount === 0
            && result.notBackedUp === 0 && result.atHomeLost === 0;
        body = (
            <View style={styles.centered}>
                <View style={styles.iconCircle}>
                    <ShieldCheck size={48} color="#34C759" />
                </View>
                <Text style={styles.title}>
                    {allAtHomeLost
                        ? 'Your photos are missing from your computer'
                        : result.safeCount === 0 && !onlyAtHome
                        ? 'Nothing is backed up yet'
                        : allSafe ? 'Your photos are safe at home' : 'Most of your photos are safe at home'}
                </Text>
                {result.safeCount > 0 && (
                    <>
                        <Text style={styles.bigNumber}>{describeCounts(result.safePhotos, result.safeVideos)}</Text>
                        <Text style={styles.detail}>
                            {`${result.weakEvidence ? 'backed up to' : 'checked and safe on'} ${result.computerName ? `your computer “${result.computerName}”` : 'your Lomorage computer'}`}
                        </Text>
                        {result.lastBackupAt && (
                            <Text style={styles.detail}>{`Last backup: ${describeWhen(result.lastBackupAt)}`}</Text>
                        )}
                        {result.safeBytes > 0 && (
                            <Text style={styles.freeable}>
                                {result.sizeIsPartial ? 'At least ' : ''}{formatSize(result.safeBytes)} can be freed from this phone
                            </Text>
                        )}
                    </>
                )}
                {onlyAtHome && (
                    <>
                        <Text style={styles.bigNumber}>{describeCounts(result.atHomePhotos, result.atHomeVideos)}</Text>
                        <Text style={styles.detail}>
                            {`checked and safe on ${result.computerName ? `your computer “${result.computerName}”` : 'your Lomorage computer'}`}
                        </Text>
                        {result.lastBackupAt && (
                            <Text style={styles.detail}>{`Last backup: ${describeWhen(result.lastBackupAt)}`}</Text>
                        )}
                        <Text style={styles.freeable}>Nothing left on this phone to free up</Text>
                    </>
                )}
                {originalsPath && (result.safeCount > 0 || onlyAtHome) && (
                    <Text style={styles.detail}>{`Originals are kept on that computer in ${originalsPath}`}</Text>
                )}
                {result.atHomeLost > 0 && (
                    <Text style={styles.note}>
                        {result.atHomeLost === 1
                            ? '1 freed from this phone is no longer on your Lomorage computer.'
                            : `${result.atHomeLost.toLocaleString('en-US')} freed from this phone are no longer on your Lomorage computer.`}
                    </Text>
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
                {result.restoringCount > 0 && (
                    <Text style={styles.note}>
                        {result.restoringCount === 1
                            ? "Restoring 1 to your computer — it had lost it. It stays on this phone until that's done."
                            : `Restoring ${result.restoringCount.toLocaleString('en-US')} to your computer — it had lost them. They stay on this phone until that's done.`}
                    </Text>
                )}
                {result.missingCount > 0 && (
                    <Text style={styles.note}>
                        {result.missingCount === 1
                            ? '1 is missing from your Lomorage computer — it stays on this phone.'
                            : `${result.missingCount.toLocaleString('en-US')} are missing from your Lomorage computer — they stay on this phone.`}
                    </Text>
                )}
                {result.unconfirmedCount - result.restoringCount - result.missingCount > 0 && (
                    <Text style={styles.note}>
                        {`${(result.unconfirmedCount - result.restoringCount - result.missingCount).toLocaleString('en-US')} couldn't be confirmed — they stay on this phone.`}
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
