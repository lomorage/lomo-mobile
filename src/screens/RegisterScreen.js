import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, ScrollView } from 'react-native';
import AuthService from '../services/AuthService';
import DiscoveryService from '../services/DiscoveryService';
import { Eye, EyeOff, ArrowLeft, HardDrive, CheckCircle } from 'lucide-react-native';
import { useAuth } from '../context/AuthContext';

export default function RegisterScreen({ navigation }) {
    const { login: contextLogin } = useAuth();
    const [server, setServer] = useState('');
    const [disks, setDisks] = useState([]);
    const [selectedDisk, setSelectedDisk] = useState(null);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    
    const [loading, setLoading] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [fetchingDisks, setFetchingDisks] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    useEffect(() => {
        setIsScanning(true);
        const unsubscribe = DiscoveryService.onDiscovered((service) => {
            setServer(service.address);
            fetchDisks(service.address);
            setIsScanning(false);
        });

        DiscoveryService.scan(15000).then(() => {
            setIsScanning(false);
        });

        return () => {
            unsubscribe();
        };
    }, []);

    const fetchDisks = async (serverUrl) => {
        setFetchingDisks(true);
        try {
            const availableDisks = await AuthService.getAvailableDisks(serverUrl);
            setDisks(availableDisks);
            if (availableDisks.length > 0) {
                // Auto-select disk with most free space (mirroring iOS logic)
                const recommended = [...availableDisks].sort((a, b) => b.freeSize - a.freeSize)[0];
                setSelectedDisk(recommended.name);
            }
        } catch (error) {
            console.error('Disk fetch error:', error);
        } finally {
            setFetchingDisks(false);
        }
    };

    const handleRegister = async () => {
        if (!server || !username || !password || !selectedDisk) {
            Alert.alert('Error', 'Please fill in all fields and select a storage disk');
            return;
        }

        if (password !== confirmPassword) {
            Alert.alert('Error', 'Passwords do not match');
            return;
        }

        if (password.length < 6) {
            Alert.alert('Error', 'Password must be at least 6 characters');
            return;
        }

        setLoading(true);
        try {
            await AuthService.register(server, username, password, selectedDisk);
            // AuthService.register automatically logs in on success
            // AuthContext will update and RootNavigator will show Home
        } catch (error) {
            Alert.alert('Registration Failed', error.message);
        } finally {
            setLoading(false);
        }
    };

    const formatBytes = (mb) => {
        if (mb === 0) return '0 MB';
        const gb = mb / 1024;
        if (gb > 1) return `${gb.toFixed(1)} GB`;
        return `${mb} MB`;
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
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
                        <ArrowLeft size={24} color="#1A202C" />
                    </TouchableOpacity>
                    <Text style={styles.title}>Create Account</Text>
                    <Text style={styles.subtitle}>Set up your private photo vault</Text>
                </View>

                <View style={styles.formContainer}>
                    {/* Server Selection */}
                    <View style={styles.inputGroup}>
                        <View style={styles.labelRow}>
                            <Text style={styles.label}>Server Address</Text>
                            {isScanning && (
                                <ActivityIndicator size="small" color="#007AFF" />
                            )}
                        </View>
                        <TextInput
                            style={styles.input}
                            placeholder="e.g., 192.168.1.100:8000"
                            value={server}
                            onChangeText={(val) => {
                                setServer(val);
                                if (val.includes(':')) fetchDisks(val);
                            }}
                            autoCapitalize="none"
                        />
                    </View>

                    {/* Disk Selection */}
                    <View style={styles.inputGroup}>
                        <Text style={styles.label}>Storage Location</Text>
                        {fetchingDisks ? (
                            <ActivityIndicator style={{marginVertical: 10}} color="#007AFF" />
                        ) : disks.length > 0 ? (
                            <View style={styles.diskList}>
                                {disks.map((disk) => (
                                    <TouchableOpacity 
                                        key={disk.name}
                                        style={[
                                            styles.diskCard, 
                                            selectedDisk === disk.name && styles.diskCardSelected
                                        ]}
                                        onPress={() => setSelectedDisk(disk.name)}
                                    >
                                        <HardDrive 
                                            size={20} 
                                            color={selectedDisk === disk.name ? '#007AFF' : '#718096'} 
                                        />
                                        <View style={styles.diskInfo}>
                                            <Text style={[styles.diskName, selectedDisk === disk.name && styles.diskNameSelected]}>
                                                {disk.name}
                                            </Text>
                                            <Text style={styles.diskSpace}>
                                                {formatBytes(disk.freeSize)} free of {formatBytes(disk.totalSize)}
                                            </Text>
                                        </View>
                                        {selectedDisk === disk.name && (
                                            <CheckCircle size={20} color="#007AFF" />
                                        )}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        ) : (
                            <Text style={styles.emptyText}>No disks found. Scan or enter server address.</Text>
                        )}
                    </View>

                    {/* Credentials */}
                    <View style={styles.inputGroup}>
                        <Text style={styles.label}>Username</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Choose a username"
                            value={username}
                            onChangeText={setUsername}
                            autoCapitalize="none"
                        />
                    </View>

                    <View style={styles.inputGroup}>
                        <Text style={styles.label}>Password</Text>
                        <View style={styles.passwordContainer}>
                            <TextInput
                                style={styles.passwordInput}
                                placeholder="Min 6 characters"
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

                    <View style={styles.inputGroup}>
                        <Text style={styles.label}>Confirm Password</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Repeat password"
                            value={confirmPassword}
                            onChangeText={setConfirmPassword}
                            secureTextEntry={!showPassword}
                        />
                    </View>

                    <TouchableOpacity 
                        style={[styles.button, loading && styles.buttonDisabled]} 
                        onPress={handleRegister}
                        disabled={loading}
                    >
                        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Register & Log In</Text>}
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F7F9FC' },
    scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },
    header: { marginTop: 60, marginBottom: 30 },
    backButton: { marginBottom: 20 },
    title: { fontSize: 32, fontWeight: '800', color: '#1A202C' },
    subtitle: { fontSize: 16, color: '#718096', marginTop: 4 },
    formContainer: { backgroundColor: '#fff', borderRadius: 16, padding: 20, elevation: 2 },
    inputGroup: { marginBottom: 20 },
    labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    label: { fontSize: 14, fontWeight: '600', color: '#4A5568', marginBottom: 8 },
    input: { height: 52, borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 12, paddingHorizontal: 16, fontSize: 16, backgroundColor: '#F8FAFC' },
    passwordContainer: { flexDirection: 'row', alignItems: 'center', height: 52, borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 12, paddingHorizontal: 16, backgroundColor: '#F8FAFC' },
    passwordInput: { flex: 1, fontSize: 16 },
    diskList: { marginTop: 4 },
    diskCard: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 12, marginBottom: 8, backgroundColor: '#fff' },
    diskCardSelected: { borderColor: '#007AFF', backgroundColor: '#F0F7FF' },
    diskInfo: { flex: 1, marginLeft: 12 },
    diskName: { fontSize: 14, fontWeight: '600', color: '#2D3748' },
    diskNameSelected: { color: '#007AFF' },
    diskSpace: { fontSize: 12, color: '#718096' },
    button: { backgroundColor: '#007AFF', height: 52, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
    buttonDisabled: { backgroundColor: '#A0AEC0' },
    buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    emptyText: { fontSize: 12, color: '#A0AEC0', textAlign: 'center', fontStyle: 'italic' }
});
