import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator, CardStyleInterpolators } from '@react-navigation/stack';
import { View, Text, ActivityIndicator, StatusBar, Platform } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { SettingsProvider } from '../context/SettingsContext';

import HomeScreen from '../screens/HomeScreen';
import AssetDetailScreen from '../screens/AssetDetailScreen';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import SettingsScreen from '../screens/SettingsScreen';
import PhotoMapScreen from '../screens/PhotoMapScreen';
import AlbumsScreen from '../screens/AlbumsScreen';
import FolderDetailScreen from '../screens/FolderDetailScreen';
import AlbumDetailScreen from '../screens/AlbumDetailScreen';
import AuthService from '../services/AuthService';
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

function Navigation() {
    const { isAuthenticated, isLoading } = useAuth();

    if (isLoading) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#007AFF" />
            </View>
        );
    }

    return (
        <NavigationContainer>
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
                            name="PhotoMap" 
                            component={PhotoMapScreen} 
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen 
                            name="Register" 
                            component={RegisterScreen} 
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
