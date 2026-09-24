import React, { useState, useEffect, useRef } from 'react';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator, CardStyleInterpolators } from '@react-navigation/stack';
import { View, Text, ActivityIndicator, StatusBar, Platform, Linking, Alert } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { SettingsProvider } from '../context/SettingsContext';

import HomeScreen from '../screens/HomeScreen';
import AssetDetailScreen from '../screens/AssetDetailScreen';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import ScanLoginScreen from '../screens/ScanLoginScreen';
import ShowSignInCodeScreen from '../screens/ShowSignInCodeScreen';
import SettingsScreen from '../screens/SettingsScreen';
import FreeUpSpaceScreen from '../screens/FreeUpSpaceScreen';
import PhotoMapScreen from '../screens/PhotoMapScreen';
import AlbumsScreen from '../screens/AlbumsScreen';
import FolderDetailScreen from '../screens/FolderDetailScreen';
import AlbumDetailScreen from '../screens/AlbumDetailScreen';
import DuplicatesScreen from '../screens/DuplicatesScreen';
import AuthService from '../services/AuthService';
import { setupLinkAction } from './setupLinkHelpers';
import * as SecureStore from 'expo-secure-store';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';


import { Image as ImageIcon, Folder } from 'lucide-react-native';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

function MainTabNavigator() {
    return (
        <Tab.Navigator
            detachInactiveScreens={false}
            screenOptions={{
                tabBarActiveTintColor: '#007AFF',
                tabBarInactiveTintColor: '#8E8E93',
                tabBarStyle: {
                    borderTopWidth: 1,
                    borderTopColor: '#E5E5EA',
                    paddingTop: 8,
                    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
                    height: Platform.OS === 'ios' ? 85 : 65,
                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                    elevation: 0,
                    shadowOpacity: 0.05,
                    shadowRadius: 10,
                },
                headerTitleStyle: {
                    fontWeight: '700',
                },
                tabBarLabelStyle: {
                    fontSize: 11,
                    fontWeight: '500',
                    marginTop: 2,
                }
            }}
        >
            <Tab.Screen 
                name="Photos" 
                component={HomeScreen} 
                options={{
                    tabBarIcon: ({ color, size }) => <ImageIcon color={color} size={24} strokeWidth={2.5} />,
                    headerShown: false // HomeScreen has its own header
                }}
            />
            <Tab.Screen 
                name="Albums" 
                component={AlbumsScreen} 
                options={{
                    tabBarIcon: ({ color, size }) => <Folder color={color} size={24} strokeWidth={2.5} />,
                    headerShown: false
                }}
            />
        </Tab.Navigator>
    );
}

// A server's setup QR code is a https://lomorage.com/s/#server=... link, which
// the OS hands to this app when it's installed (Universal Links / App Links).
// Treat it like scanning the same code in ScanLoginScreen: confirm the server,
// since anyone can craft such a link, then start account setup on it. What to
// do with each URL is decided by setupLinkAction.
const LAST_INITIAL_LINK_KEY = 'lomorage_last_initial_link';
let initialLinkHandled = false;

function useSetupLinks(navigationRef, enabled, isAuthenticated) {
    const pending = useRef(null);
    const isAuthenticatedRef = useRef(isAuthenticated);
    isAuthenticatedRef.current = isAuthenticated;

    const show = (action) => {
        if (action.type === 'signed-in') {
            Alert.alert('Already signed in', 'To set up a different server, sign out in Settings first, then scan its code again.');
            return;
        }
        const { server, serverName } = action.result;
        const label = serverName ? `${serverName} (${server})` : server;
        Alert.alert('Connect to this server?', `This will start account setup on ${label}.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Continue', onPress: () => navigationRef.navigate('Register', { server, serverName }) },
        ]);
    };

    // Rebuilt every render and read through a ref, so the Linking listener the
    // effect below registers once always sees the current auth state.
    const handleRef = useRef(null);
    handleRef.current = async (url, isInitial) => {
        let lastInitialUrl = null;
        if (isInitial && url) {
            lastInitialUrl = await SecureStore.getItemAsync(LAST_INITIAL_LINK_KEY).catch(() => null);
            SecureStore.setItemAsync(LAST_INITIAL_LINK_KEY, url).catch(() => {});
        }
        const action = setupLinkAction(url, { isAuthenticated: isAuthenticatedRef.current, isInitial, lastInitialUrl });
        if (action.type === 'ignore') return;
        if (navigationRef.isReady()) show(action);
        else pending.current = action;
    };

    useEffect(() => {
        if (!enabled) return undefined;
        if (!initialLinkHandled) {
            initialLinkHandled = true;
            Linking.getInitialURL().then((url) => handleRef.current(url, true)).catch(() => {});
        }
        const sub = Linking.addEventListener('url', ({ url }) => handleRef.current(url, false));
        return () => sub.remove();
    }, [enabled]);

    // Flush a link that arrived before the navigator finished mounting.
    return () => {
        if (pending.current) {
            const action = pending.current;
            pending.current = null;
            show(action);
        }
    };
}

function Navigation() {
    const { isAuthenticated, isLoading } = useAuth();
    const navigationRef = useNavigationContainerRef();
    const onNavigationReady = useSetupLinks(navigationRef, !isLoading, isAuthenticated);

    if (isLoading) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#007AFF" />
            </View>
        );
    }

    return (
        <NavigationContainer ref={navigationRef} onReady={onNavigationReady}>
            <Stack.Navigator
                screenOptions={{
                    headerStyle: {
                        backgroundColor: '#fff',
                        elevation: 0, // Remove shadow on Android
                        shadowOpacity: 0, // Remove shadow on iOS
                    },
                    headerTintColor: '#1A202C',
                    headerTitleStyle: {
                        fontWeight: '700',
                    },
                    headerTitleAlign: 'center',
                    cardStyle: { backgroundColor: '#fff' },
                }}
            >
                {!isAuthenticated ? (
                    <>
                        <Stack.Screen 
                            name="Login" 
                            component={LoginScreen} 
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen
                            name="Register"
                            component={RegisterScreen}
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen
                            name="ScanLogin"
                            component={ScanLoginScreen}
                            options={{ headerShown: false }}
                        />
                    </>
                ) : (
                    <>
                        <Stack.Screen
                            name="MainTabs"
                            component={MainTabNavigator}
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen
                            name="FolderDetail"
                            component={FolderDetailScreen}
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen
                            name="AlbumDetail"
                            component={AlbumDetailScreen}
                            options={{ headerShown: false }} // AlbumDetailScreen manages its own header title
                        />
                        <Stack.Screen
                            name="AssetDetail"
                            component={AssetDetailScreen}
                            options={{ 
                                headerShown: false,
                                cardStyleInterpolator: CardStyleInterpolators.forHorizontalIOS
                            }}
                        />
                        <Stack.Screen 
                            name="Settings" 
                            component={SettingsScreen} 
                            options={{ headerShown: false }} 
                        />
                        <Stack.Screen 
                            name="FreeUpSpace" 
                            component={FreeUpSpaceScreen} 
                            options={{ headerShown: false }} 
                        />
                        <Stack.Screen 
                            name="PhotoMap" 
                            component={PhotoMapScreen} 
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen 
                            name="Duplicates" 
                            component={DuplicatesScreen} 
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen
                            name="Register"
                            component={RegisterScreen}
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen
                            name="ShowSignInCode"
                            component={ShowSignInCodeScreen}
                            options={{ headerShown: false }}
                        />
                    </>
                )}
            </Stack.Navigator>
        </NavigationContainer>
    );
}

export default function RootNavigator() {
    return (
        <SafeAreaProvider>
            <AuthProvider>
                <SettingsProvider>
                    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top', 'bottom']}>
                        <StatusBar barStyle="dark-content" />
                        <Navigation />
                    </SafeAreaView>
                </SettingsProvider>
            </AuthProvider>
        </SafeAreaProvider>
    );
}
