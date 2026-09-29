import React, { createContext, useState, useContext, useEffect } from 'react';
import AuthService from '../services/AuthService';
import FirstBackupService from '../services/FirstBackupService';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const isAuth = await AuthService.init();
        setIsAuthenticated(isAuth);
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        setIsLoading(false);
      }
    };
    checkAuth();
  }, []);

  // Register the session-expiry callback so 401 triggers logout
  useEffect(() => {
    console.log('[AuthContext] Registering _onSessionExpired callback');
    AuthService.setOnSessionExpired(async () => {
      console.log('[AuthContext] Session expired, logging out...');
      await AuthService.logout();
      setIsAuthenticated(false);
    });
    return () => {
      console.log('[AuthContext] Unregistering _onSessionExpired callback');
      AuthService.setOnSessionExpired(null);
    };
  }, []);

  const login = async (server, username, password, serverName = null) => {
    await AuthService.login(server, username, password, serverName);
    await FirstBackupService.beginIfNeeded().catch((error) => {
      console.warn('[AuthContext] Failed to initialize first-backup guidance:', error);
    });
    setIsAuthenticated(true);
  };

  const register = async (server, username, password, homedir, autoLogin = true) => {
    await AuthService.register(server, username, password, homedir, "", autoLogin);
    if (autoLogin) {
      await FirstBackupService.beginIfNeeded().catch((error) => {
        console.warn('[AuthContext] Failed to initialize first-backup guidance:', error);
      });
      setIsAuthenticated(true);
    }
  };

  const logout = async () => {
    await AuthService.logout();
    setIsAuthenticated(false);
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
