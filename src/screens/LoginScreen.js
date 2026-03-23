import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, ScrollView } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AuthService from '../services/AuthService';
import Zeroconf from 'react-native-zeroconf';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';

const zeroconf = new Zeroconf();

export default function LoginScreen({ navigation }) {
    const { login: contextLogin } = useAuth();
    const [server, setServer] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    const isScanningRef = React.useRef(false);

    useEffect(() => {
        // Pre-fill fields if they exist from a previous session
        const loadPreviousData = async () => {
            const savedServer = await SecureStore.getItemAsync('lomo_server_url');
            const savedUser = await SecureStore.getItemAsync('lomo_username');
            if (savedServer) setServer(savedServer.replace(/^https?:\/\//, ''));
            if (savedUser) setUsername(savedUser);
        };
        loadPreviousData();

        // Start mDNS Scan
        isScanningRef.current = true;
        setIsScanning(true);
        zeroconf.scan('lomod', 'tcp', 'local.');

        zeroconf.on('start', () => console.log('mDNS scan started.'));
        zeroconf.on('found', name => console.log(`Found service: ${name}`));
        
        zeroconf.on('resolved', (service) => {
            console.log('Resolved service:', service);
            if (service.host && service.port) {
                const ip = (service.addresses && service.addresses.length > 0) ? service.addresses[0] : service.host;
                setServer(`${ip}:${service.port}`);
                isScanningRef.current = false;
                setIsScanning(false);
                zeroconf.stop();
            }
        });

        zeroconf.on('error', err => {
            console.warn('Zeroconf error:', err);
            isScanningRef.current = false;
            setIsScanning(false);
        });

        // Auto-stop scanning after 15 seconds
        const scanTimeout = setTimeout(() => {
            if (isScanningRef.current) {
                console.log('mDNS scan timed out.');
                isScanningRef.current = false;
                setIsScanning(false);
                zeroconf.stop();
            }
        }, 15000);

        return () => {
            clearTimeout(scanTimeout);
            zeroconf.stop();
            zeroconf.removeDeviceListeners();
        };
    }, []); // Empty array: run only once on mount

    const handleLogin = async () => {
        if (!server || !username || !password) {
            Alert.alert('Error', 'Please fill in all fields');
            return;
        }

        setLoading(true);
        try {
            await contextLogin(server, username, password);
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
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            <ScrollView 
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                <View style={styles.content}>
                    <View style={styles.headerContainer}>
                        <Text style={styles.title}>Lomorage</Text>
                        <Text style={styles.subtitle}>Sign in to your private photo backup</Text>
                    </View>
                    
                    <View style={styles.formContainer}>
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
                                    <Ionicons 
                                        name={showPassword ? 'eye-off' : 'eye'} 
                                        size={24} 
                                        color="#999" 
                                    />
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
                    </View>
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
});
