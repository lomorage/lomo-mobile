import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import Argon2 from 'react-native-argon2';
import { Alert } from 'react-native';

axios.defaults.timeout = 10000; // Global 10s fallback to prevent native Java SocketTimeout popups

const TOKEN_KEY = 'lomo_auth_token';
const SERVER_KEY = 'lomo_server_url';
const USERNAME_KEY = 'lomo_username';
const SERVER_NAME_KEY = 'lomo_server_name';

const SALT_POSTFIX = '@lomorage.lomoware';

const stringToHex = (str) => {
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    hex += charCode.toString(16).padStart(2, '0');
  }
  return hex;
};

const stringToBase64 = (str) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let encoded = '';
  for (let i = 0; i < str.length; i += 3) {
    const char1 = str.charCodeAt(i);
    const char2 = str.charCodeAt(i + 1);
    const char3 = str.charCodeAt(i + 2);

    const byte1 = char1 >> 2;
    const byte2 = ((char1 & 3) << 4) | (char2 >> 4);
    const byte3 = ((char2 & 15) << 2) | (char3 >> 6);
    const byte4 = char3 & 63;

    encoded += chars.charAt(byte1);
    encoded += chars.charAt(byte2);
    encoded += isNaN(char2) ? '=' : chars.charAt(byte3);
    encoded += isNaN(char3) ? '=' : chars.charAt(byte4);
  }
  return encoded;
};

const hashPassword = async (username, password) => {
    try {
        // react-native-argon2 exports the argon2 function as the default
        const result = await Argon2(password, username + SALT_POSTFIX, {
            mode: 'argon2id',
            hashLength: 32,
            iterations: 3,
            memory: 4096, // 4 MB, matching iOS default
            parallelism: 1, // 1 thread, matching iOS default
        });
        console.log('Argon2 hash result keys:', Object.keys(result));
        
        // The server expects the Hex-encoded version of the full Argon2 encoded string
        // including the $argon2id... prefix, followed by a null terminator '00'.
        const hexHash = stringToHex(result.encodedHash) + '00';
        return hexHash;
    } catch (error) {
        console.error('Argon2 hash error:', error);
        throw new Error('Password processing failed');
    }
}

class AuthService {
  constructor() {
    this.token = null;
    this.serverUrl = null;
    this.serverName = null;
    this.isProbing = false;
    this.isShowingProbeAlert = false;
    this._isShowingSessionAlert = false;
    // Callback to notify the app (AuthContext) that the session expired
    this._onSessionExpired = null;
  }

  /**
   * Register a callback for when a 401 is detected.
   * AuthContext will call this to hook up logout + navigate to login.
   */
  setOnSessionExpired(callback) {
    this._onSessionExpired = callback;
  }


  async init() {
    try {
      this.token = await SecureStore.getItemAsync(TOKEN_KEY);
      this.serverUrl = await SecureStore.getItemAsync(SERVER_KEY);
      this.serverName = await SecureStore.getItemAsync(SERVER_NAME_KEY);
      return this.isAuthenticated();
    } catch (e) {
      console.error('Failed to initialize auth state', e);
      return false;
    }
  }

  getServerName() {
    return this.serverName;
  }

  async updateServerUrl(url, name = null) {
      this.serverUrl = url;
      await SecureStore.setItemAsync(SERVER_KEY, url);
      if (name) {
          this.serverName = name;
          await SecureStore.setItemAsync(SERVER_NAME_KEY, name);
      }
      console.log(`[AuthService] Server URL updated to: ${url}`);
  }

  /**
   * Scans the local network via mDNS and reconnects to the Lomorage server.
   * If a stored server name is known, prefers the matching server.
   * Otherwise, tries each discovered server for connectivity and uses the first one that responds.
   * Returns true if a server was found and the URL was updated (or confirmed).
   */
  async autoProbe() {
    if (this.isProbing) return false;
    this.isProbing = true;
    console.log('[AuthService] Starting auto-probe...');

    try {
      const DiscoveryService = require('./DiscoveryService').default;
      const discovered = await DiscoveryService.scan(5000);

      if (discovered.length === 0) {
        console.log('[AuthService] Auto-probe: no Lomorage servers found on network.');
        return false;
      }

      console.log(`[AuthService] Auto-probe: found ${discovered.length} server(s):`, discovered.map(s => s.name));

      // 1. If we have a stored name, prefer an exact match
      if (this.serverName) {
        const match = discovered.find(s => s.name === this.serverName);
        if (match) {
          if (match.fullUrl !== this.serverUrl) {
            console.log(`[AuthService] Auto-probe: matched by name, new address: ${match.fullUrl}`);
            await this.updateServerUrl(match.fullUrl);
          } else {
            console.log(`[AuthService] Auto-probe: matched by name, same address confirmed.`);
          }
          return true;
        }
        console.log(`[AuthService] Auto-probe: no server matching name "${this.serverName}", trying all discovered...`);
      }

      // 2. No name match (or no name stored): try each server for connectivity
      //    Use fetch() instead of axios to completely bypass our interceptor
      for (const server of discovered) {
        try {
          console.log(`[AuthService] Auto-probe: testing connectivity at ${server.fullUrl}`);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const response = await fetch(`${server.fullUrl}/`, {
            method: 'GET',
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          // Any response means the server is reachable
          console.log(`[AuthService] Auto-probe: ${server.fullUrl} is reachable (status ${response.status}). Updating.`);
          await this.updateServerUrl(server.fullUrl, server.name);
          return true;
        } catch (e) {
          console.log(`[AuthService] Auto-probe: ${server.fullUrl} not reachable: ${e.message}`);
        }
      }

      console.log('[AuthService] Auto-probe: no reachable server found.');
      return false;
    } catch (error) {
      console.error('[AuthService] Auto-probe error:', error);
      return false;
    } finally {
      this.isProbing = false;
    }
  }

  isAuthenticated() {
    return !!this.token && !!this.serverUrl;
  }

  getToken() {
    return this.token;
  }

  getServerUrl() {
    return this.serverUrl;
  }

  async login(serverAddress, username, password, serverName = null) {
    if (!serverAddress || !username || !password) {
      throw new Error('Server, username, and password are required');
    }

    try {
      const url = serverAddress.startsWith('http') ? serverAddress : `http://${serverAddress}`;
      this.serverUrl = url;
      this.serverName = serverName;

      // Hash the password with Argon2id, matching the lomo-ios implementation
      console.log('Hashing password with Argon2id...');
      const hashedPassword = await hashPassword(username, password);
      console.log('Password hashed successfully.');

      // Build Basic auth header: base64(username:hashedPassword:deviceId)
      const deviceId = 'android-lomo-mobile';
      const credentials = `${username}:${hashedPassword}:${deviceId}`;
      
      // btoa is not available in React Native, use a simple base64 alternative
      const base64Credentials = stringToBase64(credentials);

      console.log('Sending GET /login request...');
      const response = await axios.get(`${url}/login`, {
        headers: {
          Authorization: `Basic ${base64Credentials}`,
        },
      });

      console.log('Login response data:', JSON.stringify(response.data));

      // iOS parses: Token and Userid from response (capital T)
      if (response.status === 200 && response.data && response.data.Token) {
        this.token = response.data.Token;
        
        await SecureStore.setItemAsync(TOKEN_KEY, this.token);
        await SecureStore.setItemAsync(SERVER_KEY, this.serverUrl);
        await SecureStore.setItemAsync(USERNAME_KEY, username);
        if (this.serverName) {
            await SecureStore.setItemAsync(SERVER_NAME_KEY, this.serverName);
        }
        
        return true;
      } else {
        console.error('Unexpected response:', JSON.stringify(response.data));
        throw new Error('Invalid response from server');
      }
    } catch (error) {
      this.token = null;
      this.serverUrl = null;
      if (error.response) {
        console.error('Server response status:', error.response.status);
        console.error('Server response data:', JSON.stringify(error.response.data));
        if (error.response.status === 401) {
          throw new Error('Invalid username or password');
        }
      }
      console.error('Login error:', error.message);
      throw new Error(error.message || 'Failed to connect to server');
    }
  }

  async getAvailableDisks(serverAddress) {
    if (!serverAddress) throw new Error('Server address is required');
    const url = serverAddress.startsWith('http') ? serverAddress : `http://${serverAddress}`;
    
    try {
      console.log(`Fetching available disks from: ${url}/disk`);
      const response = await axios.get(`${url}/disk`);
      
      if (response.status === 200 && Array.isArray(response.data)) {
        return response.data.map(d => ({
          name: d.Dir,
          freeSize: d.FreeSize, // In MB
          totalSize: d.TotalSize,
          error: d.Error
        })).filter(d => !d.error);
      }
      return [];
    } catch (error) {
      console.error('Failed to get disks:', error.message);
      throw new Error('Could not connect to server to fetch storage info');
    }
  }

  async register(serverAddress, username, password, homedir, nickName = "") {
    if (!serverAddress || !username || !password || !homedir) {
      throw new Error('All fields are required');
    }

    try {
      const url = serverAddress.startsWith('http') ? serverAddress : `http://${serverAddress}`;
      const hashedPassword = await hashPassword(username, password);

      const payload = {
        Name: username,
        Password: hashedPassword,
        NickName: nickName,
        HomeDir: homedir,
        BotUser: false
      };

      console.log('Registering user at:', `${url}/user`);
      const response = await axios.post(`${url}/user`, payload);

      if (response.status === 200) {
        console.log('Registration successful, logging in...');
        // Automatically login after successful registration
        return await this.login(serverAddress, username, password);
      } else {
        throw new Error('Server returned an error during registration');
      }
    } catch (error) {
      if (error.response?.status === 409) {
        throw new Error('Username already exists on this server');
      }
      console.error('Registration error:', error.message);
      throw new Error(error.message || 'Failed to create account');
    }
  }

  async logout() {
    this.token = null;
    this.serverUrl = null;
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(SERVER_KEY);
      await SecureStore.deleteItemAsync(SERVER_NAME_KEY);
      // We keep username for convenience on next login
    } catch (e) {
      console.error('Error clearing secure store', e);
    }
  }
}

const authService = new AuthService();

// Axios Interceptor for Interactive Re-Probing
axios.interceptors.response.use(
    response => response,
    async (error) => {
        const originalRequest = error.config;

        // Only trigger on network errors or timeouts, and only once per request
        const isNetworkError = !error.response && (
            error.code === 'ECONNABORTED' ||
            error.message?.includes('Network Error') ||
            error.code === 'ETIMEDOUT'
        );

        // Guard: skip if already retried, if we're currently probing (avoid loop),
        // or if we're already showing an alert
        if (isNetworkError && !originalRequest._retry && !authService.isProbing && !authService.isShowingProbeAlert) {
            authService.isShowingProbeAlert = true;

            return new Promise((resolve, reject) => {
                Alert.alert(
                    "Connection Lost",
                    "We couldn't reach your Lomorage server. This may happen if its IP address changed. Tap \"Re-scan\" to search for it on your local network.",
                    [
                        {
                            text: "Cancel",
                            style: "cancel",
                            onPress: () => {
                                authService.isShowingProbeAlert = false;
                                reject(error);
                            }
                        },
                        {
                            text: "Re-scan Network",
                            onPress: async () => {
                                console.log('[AuthService] User requested re-probe after network error.');
                                const found = await authService.autoProbe();
                                authService.isShowingProbeAlert = false;

                                if (found) {
                                    // Rebuild the request URL using the fresh server URL
                                    originalRequest._retry = true;
                                    const newBaseUrl = authService.getServerUrl();
                                    try {
                                        const parsedUrl = new URL(originalRequest.url);
                                        const newUrl = new URL(parsedUrl.pathname + parsedUrl.search, newBaseUrl);
                                        originalRequest.url = newUrl.href;
                                    } catch (parseErr) {
                                        originalRequest.baseURL = newBaseUrl;
                                    }
                                    console.log(`[AuthService] Retrying request at: ${originalRequest.url}`);
                                    resolve(axios(originalRequest));
                                } else {
                                    reject(error);
                                }
                            }
                        }
                    ]
                );
            });
        }

        return Promise.reject(error);
    }
);

// Axios Interceptor for Session Expiry (401)
axios.interceptors.response.use(
    response => response,
    async (error) => {
        if (error.response && error.response.status === 401 && !authService._isShowingSessionAlert) {
            authService._isShowingSessionAlert = true;
            Alert.alert(
                "Session Expired",
                "Your login session has expired. Please log in again to continue.",
                [
                    {
                        text: "Log In",
                        onPress: () => {
                            authService._isShowingSessionAlert = false;
                            if (authService._onSessionExpired) {
                                authService._onSessionExpired();
                            }
                        }
                    }
                ]
            );
        }
        return Promise.reject(error);
    }
);

export default authService;

