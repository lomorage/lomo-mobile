import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, ScrollView } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AuthService from '../services/AuthService';
import DiscoveryService from '../services/DiscoveryService';
import { Eye, EyeOff, QrCode, ArrowLeft } from 'lucide-react-native';

import { useAuth } from '../context/AuthContext';

export default function LoginScreen({ navigation }) {
    const { login: contextLogin } = useAuth();
    const [mode, setMode] = useState('scan'); // 'scan' | 'manual' — scanning is the default path for family members
    const [server, setServer] = useState('');
    const [serverName, setServerName] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    useEffect(() => {
        // Pre-fill fields if they exist from a previous session
        const loadPreviousData = async () => {
            const savedServer = await SecureStore.getItemAsync('lomo_server_url');
            const savedUser = await SecureStore.getItemAsync('lomo_username');
            if (savedServer) setServer(savedServer.replace(/^https?:\/\//, ''));
            if (savedUser) setUsername(savedUser);
        };
        loadPreviousData();

        // Start mDNS Scan via DiscoveryService
        setIsScanning(true);
        const unsubscribe = DiscoveryService.onDiscovered((service) => {
            console.log('[LoginScreen] Found service:', service.name);
            setServer(service.address);
            setServerName(service.name);
            setIsScanning(false);
        });

        DiscoveryService.scan(15000).then((results) => {
            console.log('[LoginScreen] Scan finished. Found count:', results.length);
            setIsScanning(false);
        });

        return () => {
            unsubscribe();
        };
    }, []); // Empty array: run only once on mount

    const handleLogin = async () => {
        if (!server || !username || !password) {
            Alert.alert('Error', 'Please fill in all fields');
            return;
        }

        setLoading(true);
        try {
            await contextLogin(server, username, password, serverName);
            // No need for navigation.replace('MainApp') because RootNavigator 
            // will automatically re-render and show the Home screen.
        } catch (error) {
            Alert.alert('Login Failed', error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <KeyboardAvoidingView 
            style={styles.container} 
            behavior="padding"
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 80}
        >
            <ScrollView 
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                <View style={styles.content}>
                    <View style={styles.headerContainer}>
                        <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit>Lomorage</Text>
                        <Text style={styles.subtitle}>
                            {mode === 'scan' ? 'Sign in with a code from your family' : 'Sign in to your private photo backup'}
                        </Text>
                    </View>

                    {mode === 'scan' ? (
                        <View style={styles.formContainer}>
                            <View style={styles.scanIconCircle}>
                                <QrCode size={40} color="#007AFF" />
                            </View>
                            <Text style={styles.scanHeroText}>
                                Ask whoever set up Lomorage to open Settings and show you your sign-in code, then scan it here.
                            </Text>

                            <TouchableOpacity
                                style={styles.button}
                                onPress={() => navigation.navigate('ScanLogin')}
                            >
                                <Text style={styles.buttonText}>Open Camera to Scan</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={styles.registerLink}
                                onPress={() => setMode('manual')}
                            >
                                <Text style={styles.registerText}>
                                    Setting this up for the first time? <Text style={styles.registerTextBold}>Enter details manually</Text>
                                </Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <View style={styles.formContainer}>
                            <TouchableOpacity style={styles.backLink} onPress={() => setMode('scan')}>
                                <ArrowLeft size={16} color="#718096" />
                                <Text style={styles.backLinkText}>Have a sign-in code? Scan it instead</Text>
                            </TouchableOpacity>

                            <View style={styles.inputGroup}>
                                <View style={styles.labelContainer}>
                                    <Text style={styles.label}>Server Address</Text>
                                    {isScanning ? (
                                        <View style={styles.scanningBadge}>
                                            <ActivityIndicator size="small" color="#007AFF" />
                                            <Text style={styles.scanningText}>Scanning...</Text>
                                        </View>
                                    ) : null}
                                </View>
                                <TextInput
                                    style={styles.input}
                                    placeholder="e.g., 192.168.1.100:8000"
                                    placeholderTextColor="#999"
                                    value={server}
                                    onChangeText={setServer}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>

                            <View style={styles.inputGroup}>
                                <Text style={styles.label}>Username</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder="Enter username"
                                    placeholderTextColor="#999"
                                    value={username}
                                    onChangeText={setUsername}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>

                            <View style={styles.inputGroup}>
                                <Text style={styles.label}>Password</Text>
                                <View style={styles.passwordContainer}>
                                    <TextInput
                                        style={styles.passwordInput}
                                        placeholder="Enter password"
                                        placeholderTextColor="#999"
                                        value={password}
                                        onChangeText={setPassword}
                                        secureTextEntry={!showPassword}
                                    />
                                    <TouchableOpacity
                                        style={styles.eyeIcon}
                                        onPress={() => setShowPassword(!showPassword)}
                                    >
                                        {showPassword
                                            ? <EyeOff size={22} color="#999" />
                                            : <Eye size={22} color="#999" />
                                        }
                                    </TouchableOpacity>
                                </View>
                            </View>

                            <TouchableOpacity
                                style={[styles.button, loading && styles.buttonDisabled]}
                                onPress={handleLogin}
                                disabled={loading}
                            >
                                {loading ? (
                                    <ActivityIndicator color="#fff" />
                                ) : (
                                    <Text style={styles.buttonText}>Log In</Text>
                                )}
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={styles.registerLink}
                                onPress={() => navigation.navigate('Register')}
                            >
                                <Text style={styles.registerText}>
                                    Don't have an account? <Text style={styles.registerTextBold}>Create one</Text>
                                </Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    scrollContent: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    passwordContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: '#E2E8F0',
        borderRadius: 12,
        backgroundColor: '#F8FAFC',
    },
    passwordInput: {
        flex: 1,
        height: 52,
        paddingHorizontal: 16,
        fontSize: 16,
        color: '#2D3748',
    },
    eyeIcon: {
        padding: 10,
        marginRight: 5,
    },
    container: {
        flex: 1,
        backgroundColor: '#F7F9FC', // Light, professional background
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    headerContainer: {
        alignItems: 'center',
        marginBottom: 40,
    },
    title: {
        fontSize: 36,
        fontWeight: '800',
        color: '#1A202C',
        letterSpacing: -1,
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 16,
        color: '#718096',
    },
    formContainer: {
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        padding: 24,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.05,
        shadowRadius: 12,
        elevation: 2,
    },
    inputGroup: {
        marginBottom: 20,
    },
    labelContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 8,
    },
    label: {
        fontSize: 14,
        fontWeight: '600',
        color: '#4A5568',
        marginLeft: 4,
    },
    scanningBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#EBF4FF',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
    },
    scanningText: {
        fontSize: 12,
        color: '#007AFF',
        marginLeft: 4,
        fontWeight: '500',
    },
    input: {
        height: 52,
        borderWidth: 1.5,
        borderColor: '#E2E8F0',
        borderRadius: 12,
        paddingHorizontal: 16,
        fontSize: 16,
        backgroundColor: '#F8FAFC',
        color: '#2D3748',
    },
    button: {
        backgroundColor: '#007AFF',
        height: 52,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 12,
        shadowColor: '#007AFF',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 4,
    },
    buttonDisabled: {
        backgroundColor: '#A0AEC0',
        shadowOpacity: 0,
        elevation: 0,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    registerLink: {
        marginTop: 20,
        alignItems: 'center',
    },
    registerText: {
        fontSize: 14,
        color: '#718096',
    },
    registerTextBold: {
        color: '#007AFF',
        fontWeight: '700',
    },
    scanIconCircle: {
        alignSelf: 'center',
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: '#F0F7FF',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 20,
    },
    scanHeroText: {
        textAlign: 'center',
        fontSize: 15,
        lineHeight: 21,
        color: '#4A5568',
        marginBottom: 24,
        paddingHorizontal: 4,
    },
    backLink: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        marginBottom: 20,
    },
    backLinkText: {
        fontSize: 13,
        color: '#718096',
        fontWeight: '600',
        marginLeft: 6,
    },
});
