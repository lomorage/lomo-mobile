import React, { useState, useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { View, ActivityIndicator, SafeAreaView, StatusBar, Platform } from 'react-native';
import { AuthProvider, useAuth } from '../context/AuthContext';

import HomeScreen from '../screens/HomeScreen';
import AssetDetailScreen from '../screens/AssetDetailScreen';
import LoginScreen from '../screens/LoginScreen';
import AuthService from '../services/AuthService';

const Stack = createStackNavigator();

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
                }}
            >
                {!isAuthenticated ? (
                    <Stack.Screen 
                        name="Login" 
                        component={LoginScreen} 
                        options={{ headerShown: false }}
                    />
                ) : (
                    <>
                        <Stack.Screen
                            name="Home"
                            component={HomeScreen}
                            options={{ headerShown: false }}
                        />
                        <Stack.Screen
                            name="AssetDetail"
                            component={AssetDetailScreen}
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
        <AuthProvider>
            <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
                <StatusBar barStyle="dark-content" />
                <Navigation />
            </SafeAreaView>
        </AuthProvider>
    );
}
