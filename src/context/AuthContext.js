import React, { createContext, useState, useContext, useEffect } from 'react';
import AuthService from '../services/AuthService';

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
    AuthService.setOnSessionExpired(async () => {
      console.log('[AuthContext] Session expired, logging out...');
      await AuthService.logout();
      setIsAuthenticated(false);
    });
    return () => AuthService.setOnSessionExpired(null);
  }, []);

  const login = async (server, username, password, serverName = null) => {
    await AuthService.login(server, username, password, serverName);
    setIsAuthenticated(true);
  };

  const logout = async () => {
    await AuthService.logout();
    setIsAuthenticated(false);
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
