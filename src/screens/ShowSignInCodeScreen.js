import React, { useState } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react-native';
import AuthService from '../services/AuthService';
import { PAIRING_QR_TYPE } from '../constants/pairing';
import PairingQRModal from '../components/PairingQRModal';

export default function ShowSignInCodeScreen({ navigation }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [pairingPayload, setPairingPayload] = useState(null);

    const canSubmit = username.trim().length > 0 && password.length > 0;

    const handleShowQR = () => {
        if (!canSubmit) return;
        const server = (AuthService.getServerUrl() || '').replace(/^https?:\/\//, '');
        setPairingPayload({
            type: PAIRING_QR_TYPE,
            server,
            username: username.trim(),
            password,
        });
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior="padding"
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 80}
        >
            <ScrollView
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                        <ArrowLeft size={24} color="#1A202C" />
                    </TouchableOpacity>
                    <Text style={styles.title}>Show Sign-In Code</Text>
                    <Text style={styles.subtitle}>
                        Re-generate a family member's QR code any time — nothing is saved on this screen, it's built fresh from what you type in below.
                    </Text>
                </View>

                <View style={styles.formContainer}>
                    <View style={styles.inputGroup}>
                        <Text style={styles.label}>Their Username</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Enter their username"
                            value={username}
                            onChangeText={setUsername}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                    </View>

                    <View style={styles.inputGroup}>
                        <Text style={styles.label}>Their Password</Text>
                        <View style={styles.passwordContainer}>
                            <TextInput
                                style={styles.passwordInput}
                                placeholder="Enter their password"
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry={!showPassword}
                            />
                            <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                                {showPassword
                                    ? <EyeOff size={22} color="#999" />
                                    : <Eye size={22} color="#999" />
                                }
                            </TouchableOpacity>
                        </View>
                    </View>

                    <TouchableOpacity
                        style={[styles.button, !canSubmit && styles.buttonDisabled]}
                        onPress={handleShowQR}
                        disabled={!canSubmit}
                    >
                        <Text style={styles.buttonText}>Show QR Code</Text>
                    </TouchableOpacity>
                </View>
            </ScrollView>

            <PairingQRModal
                visible={!!pairingPayload}
                payload={pairingPayload}
                subtitle={`Hand your phone to ${username || 'them'} and have them open Lomorage → Scan to Sign In.`}
                onDone={() => setPairingPayload(null)}
            />
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F7F9FC' },
    scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },
    header: { marginTop: 60, marginBottom: 30 },
    backButton: { marginBottom: 20 },
    title: { fontSize: 32, fontWeight: '800', color: '#1A202C' },
    subtitle: { fontSize: 15, lineHeight: 21, color: '#718096', marginTop: 8 },
    formContainer: { backgroundColor: '#fff', borderRadius: 16, padding: 20, elevation: 2 },
    inputGroup: { marginBottom: 20 },
    label: { fontSize: 14, fontWeight: '600', color: '#4A5568', marginBottom: 8 },
    input: { height: 52, borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 12, paddingHorizontal: 16, fontSize: 16, backgroundColor: '#F8FAFC', color: '#1A202C' },
    passwordContainer: { flexDirection: 'row', alignItems: 'center', height: 52, borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 12, paddingHorizontal: 16, backgroundColor: '#F8FAFC' },
    passwordInput: { flex: 1, fontSize: 16, color: '#1A202C' },
    button: { backgroundColor: '#007AFF', height: 52, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
    buttonDisabled: { backgroundColor: '#A0AEC0' },
    buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
