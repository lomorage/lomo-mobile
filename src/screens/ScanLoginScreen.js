import React, { useState, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ArrowLeft, QrCode } from 'lucide-react-native';
import { useAuth } from '../context/AuthContext';
import { PAIRING_QR_TYPE } from '../constants/pairing';

export default function ScanLoginScreen({ navigation }) {
    const { login: contextLogin } = useAuth();
    const [permission, requestPermission] = useCameraPermissions();
    const [scanning, setScanning] = useState(true);
    const [signingIn, setSigningIn] = useState(false);
    const [scanError, setScanError] = useState(null);
    const hasHandledScan = useRef(false);

    const handleBarcodeScanned = async ({ data }) => {
        if (hasHandledScan.current || signingIn) return;

        let payload;
        try {
            payload = JSON.parse(data);
        } catch (e) {
            setScanError("That QR code isn't a Lomorage sign-in code.");
            return;
        }

        if (payload?.type !== PAIRING_QR_TYPE || !payload.server || !payload.username || !payload.password) {
            setScanError("That QR code isn't a Lomorage sign-in code.");
            return;
        }

        hasHandledScan.current = true;
        setScanning(false);
        setScanError(null);
        setSigningIn(true);
        try {
            await contextLogin(payload.server, payload.username, payload.password, payload.serverName || null);
            // RootNavigator swaps to the authenticated stack automatically once isAuthenticated flips.
        } catch (error) {
            setSigningIn(false);
            hasHandledScan.current = false;
            setScanning(true);
            setScanError(error.message || 'Sign-in failed. Ask them to show the code again.');
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                    <ArrowLeft size={24} color="#fff" />
                </TouchableOpacity>
                <Text style={styles.title}>Scan to Sign In</Text>
                <View style={{ width: 24 }} />
            </View>

            {!permission ? (
                <View style={styles.centered} />
            ) : !permission.granted ? (
                <View style={styles.centered}>
                    <QrCode size={48} color="#fff" style={{ opacity: 0.6, marginBottom: 16 }} />
                    <Text style={styles.permissionText}>
                        Lomorage needs camera access to scan the sign-in code from another device.
                    </Text>
                    {permission.canAskAgain ? (
                        <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
                            <Text style={styles.permissionButtonText}>Allow Camera Access</Text>
                        </TouchableOpacity>
                    ) : (
                        <TouchableOpacity style={styles.permissionButton} onPress={() => Linking.openSettings()}>
                            <Text style={styles.permissionButtonText}>Open Settings</Text>
                        </TouchableOpacity>
                    )}
                </View>
            ) : (
                <View style={{ flex: 1 }}>
                    {scanning ? (
                        <CameraView
                            style={StyleSheet.absoluteFill}
                            facing="back"
                            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                            onBarcodeScanned={handleBarcodeScanned}
                        />
                    ) : (
                        <View style={styles.centered}>
                            <ActivityIndicator size="large" color="#fff" />
                            <Text style={styles.signingInText}>Signing in...</Text>
                        </View>
                    )}

                    {scanning && (
                        <View style={styles.overlay} pointerEvents="none">
                            <View style={styles.frame} />
                            <Text style={styles.hint}>
                                Point the camera at the sign-in QR code shown on the other device
                            </Text>
                        </View>
                    )}

                    {scanError ? (
                        <View style={styles.errorBanner}>
                            <Text style={styles.errorText}>{scanError}</Text>
                        </View>
                    ) : null}
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0B1220' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 56,
        paddingBottom: 16,
    },
    backButton: { padding: 4 },
    title: { color: '#fff', fontSize: 17, fontWeight: '700' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    permissionText: { color: '#CBD5E1', fontSize: 15, textAlign: 'center', lineHeight: 21, marginBottom: 20 },
    permissionButton: { backgroundColor: '#007AFF', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
    permissionButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
    signingInText: { color: '#fff', fontSize: 15, marginTop: 12 },
    overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
    frame: { width: 240, height: 240, borderRadius: 16, borderWidth: 3, borderColor: 'rgba(255,255,255,0.85)' },
    hint: { color: '#fff', fontSize: 14, marginTop: 24, textAlign: 'center', paddingHorizontal: 40 },
    errorBanner: {
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 40,
        backgroundColor: 'rgba(211,47,47,0.95)',
        borderRadius: 10,
        padding: 12,
    },
    errorText: { color: '#fff', fontSize: 13, textAlign: 'center' },
});
