import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { ShieldAlert } from 'lucide-react-native';

/**
 * Shows a family member's sign-in QR built fresh from the payload passed in —
 * nothing is persisted, so this can be safely reopened any time from
 * RegisterScreen (right after creating an account) or ShowSignInCodeScreen
 * (re-generating one later) without ever saving the code to disk.
 */
export default function PairingQRModal({ visible, payload, title = 'Sign-in code', subtitle, onDone }) {
    return (
        <Modal visible={visible} animationType="fade" transparent>
            <View style={styles.overlay}>
                <View style={styles.card}>
                    <Text style={styles.title}>{title}</Text>
                    {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

                    {payload && (
                        <View style={styles.codeWrap}>
                            <QRCode value={JSON.stringify(payload)} size={200} />
                        </View>
                    )}

                    <View style={styles.warning}>
                        <ShieldAlert size={16} color="#B45309" />
                        <Text style={styles.warningText}>
                            This code contains their password. Only let them scan it directly — don&apos;t screenshot or forward it.
                        </Text>
                    </View>

                    <TouchableOpacity style={styles.button} onPress={onDone}>
                        <Text style={styles.buttonText}>Done</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    card: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 20, padding: 24, alignItems: 'center' },
    title: { fontSize: 20, fontWeight: '800', color: '#1A202C', marginBottom: 6 },
    subtitle: { fontSize: 14, color: '#718096', textAlign: 'center', lineHeight: 19, marginBottom: 20 },
    codeWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1.5, borderColor: '#E2E8F0', marginBottom: 16 },
    warning: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#FFF7ED', borderRadius: 10, padding: 12, marginBottom: 20 },
    warningText: { flex: 1, marginLeft: 8, fontSize: 12.5, lineHeight: 17, color: '#92400E' },
    button: {
        alignSelf: 'stretch',
        backgroundColor: '#007AFF',
        height: 52,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
    },
    buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
});
