import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import Argon2 from 'react-native-argon2';
import { Alert, Platform, DeviceEventEmitter } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import NetworkQueue from './NetworkQueue';

axios.defaults.timeout = 60000; // Global 60s fallback to prevent native Java SocketTimeout popups
NetworkQueue.setupInterceptors(axios);

const TOKEN_KEY = 'lomo_auth_token';
const SERVER_KEY = 'lomo_server_url';
const REMOTE_SERVER_KEY = 'lomo_remote_server_url';
const LOCAL_SERVER_KEY = 'lomo_local_server_url';
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

const formatServerUrl = (address) => {
  if (!address) return address;
  if (address.startsWith('http')) return address;
  
  // Check if it's an IPv4, IPv6, localhost, or .local address
  const isLocalOrIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?$/.test(address) || 
                      /^\[?[0-9a-fA-F:]+\]?(?::[0-9]+)?$/.test(address) || 
                      /^localhost(?::[0-9]+)?$/.test(address) ||
                      /\.local(?::[0-9]+)?$/.test(address);
                      
  // If it has a port that is NOT 443, default to http
  const portMatch = address.match(/:([0-9]+)$/);
  const hasNonHttpsPort = portMatch && portMatch[1] !== '443';
                      
  return (isLocalOrIp || hasNonHttpsPort) ? `http://${address}` : `https://${address}`;
};

class AuthService {
  constructor() {
    this.token = null;
    this.serverUrl = null;
    this.remoteUrl = null;
    this.localUrl = null;
    this.serverName = null;
    this.isProbing = false;
    this.isShowingProbeAlert = false;
    this._isShowingSessionAlert = false;
    this._onSessionExpired = null;
    this._lastNetType = null;

    // Use system-level network change events for instant, reliable switching
    NetInfo.addEventListener((state) => {
        const netType = state.type; // 'wifi', 'cellular', 'none', etc.
        const isConnected = state.isConnected;

        if (!isConnected || !this.isAuthenticated()) {
            this._lastNetType = netType;
            return;
        }

        const typeChanged = netType !== this._lastNetType;
        this._lastNetType = netType;

        if (!typeChanged) return; // Same network type, no need to probe

        console.log(`[AuthService] Network type changed to "${netType}", re-evaluating best connection...`);

        if (netType === 'wifi') {
            // Switched to Wi-Fi → immediately probe local URL first
            this.determineBestConnection();
        } else if (netType === 'cellular') {
            // Switched to cellular → local won't work, fall back to remote
            if (this.remoteUrl) {
                console.log('[AuthService] Switched to cellular, switching to remote URL.');
                this.updateServerUrl(this.remoteUrl);
            }
        } else {
            this.determineBestConnection();
        }
    });
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
      this.remoteUrl = await SecureStore.getItemAsync(REMOTE_SERVER_KEY);
      this.localUrl = await SecureStore.getItemAsync(LOCAL_SERVER_KEY);
      this.serverName = await SecureStore.getItemAsync(SERVER_NAME_KEY);
      
      if (this.isAuthenticated()) {
          this.determineBestConnection();
      }
      return this.isAuthenticated();
    } catch (e) {
      console.error('Failed to initialize auth state', e);
      return false;
    }
  }

  formatUrl(address) {
      return formatServerUrl(address);
  }

  checkIOSATS(url) {
      if (Platform.OS !== 'ios') return { valid: true };
      if (!url) return { valid: true };
      if (url.startsWith('https://')) return { valid: true };
      
      const domainPart = url.replace('http://', '');
      const isLocalOrIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?$/.test(domainPart) || 
                          /^\[?[0-9a-fA-F:]+\]?(?::[0-9]+)?$/.test(domainPart) || 
                          /^localhost(?::[0-9]+)?$/.test(domainPart) ||
                          /\.local(?::[0-9]+)?$/.test(domainPart);
                          
      if (!isLocalOrIp) {
          return {
              valid: false,
              message: "Apple iOS strict security policy (ATS) blocks plain HTTP connections to public domains. Please configure HTTPS for your domain, or use your local IP address instead."
          };
      }
      return { valid: true };
  }

  async setRemoteUrl(url) {
      this.remoteUrl = url;
      if (url) {
          await SecureStore.setItemAsync(REMOTE_SERVER_KEY, url);
      } else {
          await SecureStore.deleteItemAsync(REMOTE_SERVER_KEY);
      }
  }

  async setLocalUrl(url) {
      this.localUrl = url;
      if (url) {
          await SecureStore.setItemAsync(LOCAL_SERVER_KEY, url);
      } else {
          await SecureStore.deleteItemAsync(LOCAL_SERVER_KEY);
      }
  }

  async determineBestConnection() {
      // 1. Try Local URL first
      if (this.localUrl) {
          try {
             const controller = new AbortController();
             const timeoutId = setTimeout(() => controller.abort(), 800); // Reduced to 800ms for faster fallback
             const response = await fetch(`${this.localUrl}/system`, { method: 'GET', signal: controller.signal });
             clearTimeout(timeoutId);
             if (response.status === 200) {
                 await this.updateServerUrl(this.localUrl);
                 return true;
             }
          } catch(e) {}
      }
      
      // 2. If Local URL failed, fire off a background mDNS probe in case the IP changed
      // We don't await this so we don't block the Remote URL fallback below
      this.autoProbe().catch(console.error);
      
      // 3. Fallback to Remote URL immediately
      if (this.remoteUrl) {
          try {
             const controller = new AbortController();
             const timeoutId = setTimeout(() => controller.abort(), 3000);
             const response = await fetch(`${this.remoteUrl}/system`, { method: 'GET', signal: controller.signal });
             clearTimeout(timeoutId);
             if (response.status === 200) {
                 await this.updateServerUrl(this.remoteUrl);
                 return true;
             }
          } catch(e) {}
      }
      
      return false;
  }

  getServerName() {
    return this.serverName;
  }

  getRemoteUrl() {
    return this.remoteUrl;
  }

  getLocalUrl() {
    return this.localUrl;
  }

  async updateServerUrl(url, name = null) {
      if (this.serverUrl === url && (!name || this.serverName === name)) return;
      
      this.serverUrl = url;
      await SecureStore.setItemAsync(SERVER_KEY, url);
      if (name) {
          this.serverName = name;
          await SecureStore.setItemAsync(SERVER_NAME_KEY, name);
      }
      console.log(`[AuthService] Server URL updated to: ${url}`);
      DeviceEventEmitter.emit('onServerUrlChanged', url);
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
          await this.setLocalUrl(match.fullUrl);
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
          await this.setLocalUrl(server.fullUrl);
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
    const trimmedServer = serverAddress ? serverAddress.trim() : '';
    const trimmedUsername = username ? username.trim() : '';
    const trimmedPassword = password ? password.trim() : '';

    if (!trimmedServer || !trimmedUsername || !trimmedPassword) {
      throw new Error('Server, username, and password are required');
    }

    try {
      const url = formatServerUrl(trimmedServer);
      
      const atsCheck = this.checkIOSATS(url);
      if (!atsCheck.valid) {
          throw new Error(atsCheck.message);
      }

      this.serverUrl = url;
      this.serverName = serverName;

      // Hash the password with Argon2id, matching the lomo-ios implementation
      console.log('Hashing password with Argon2id...');
      const hashedPassword = await hashPassword(trimmedUsername, trimmedPassword);
      console.log('Password hashed successfully.');

      // Build Basic auth header: base64(username:hashedPassword:deviceId)
      const deviceId = 'android-lomo-mobile';
      const credentials = `${trimmedUsername}:${hashedPassword}:${deviceId}`;
      
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
        
        // Save user's explicit input as remote URL unless it's clearly a private IP
        const isLocalOrIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?$/.test(trimmedServer) || 
                            /^\[?[0-9a-fA-F:]+\]?(?::[0-9]+)?$/.test(trimmedServer) || 
                            /^localhost(?::[0-9]+)?$/.test(trimmedServer) ||
                            /\.local(?::[0-9]+)?$/.test(trimmedServer);
        if (isLocalOrIp) {
            await this.setLocalUrl(this.serverUrl);
        } else {
            await this.setRemoteUrl(this.serverUrl);
        }
        
        await SecureStore.setItemAsync(SERVER_KEY, this.serverUrl);
        await SecureStore.setItemAsync(USERNAME_KEY, trimmedUsername);
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
    const url = formatServerUrl(serverAddress);
    
    try {
      console.log(`Fetching available disks from: ${url}/mount`);
      const headers = {};
      if (this.token) {
        headers['Authorization'] = `token=${this.token}`;
      }
      const response = await axios.get(`${url}/mount`, { headers });
      
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

  async getServerVersion() {
    if (!this.serverUrl) return 'Unknown';
    try {
      const response = await axios.get(`${this.serverUrl}/system`, {
         headers: this.token ? { 'Authorization': `token=${this.token}` } : {}
      });
      if (response.status === 200 && response.data && response.data.LomodVersion) {
         return response.data.LomodVersion;
      }
    } catch (e) {
      console.log('Failed to fetch server version:', e.message);
    }
    return 'Unknown';
  }

  async register(serverAddress, username, password, homedir, nickName = "", autoLogin = true) {
    const trimmedServer = serverAddress ? serverAddress.trim() : '';
    const trimmedUsername = username ? username.trim() : '';
    const trimmedPassword = password ? password.trim() : '';
    const trimmedHomedir = homedir ? homedir.trim() : '';

    if (!trimmedServer || !trimmedUsername || !trimmedPassword || !trimmedHomedir) {
      throw new Error('All fields are required');
    }

    try {
      const url = formatServerUrl(trimmedServer);
      const hashedPassword = await hashPassword(trimmedUsername, trimmedPassword);

      const payload = {
        Name: trimmedUsername,
        Password: hashedPassword,
        NickName: nickName,
        HomeDir: trimmedHomedir,
        BotUser: false
      };

      console.log('Registering user at:', `${url}/user`);
      const headers = {
        'Authorization': `token=${this.token || ''}`
      };
      const response = await axios.post(`${url}/user`, payload, { headers });

      if (response.status === 200) {
        if (autoLogin) {
            console.log('Registration successful, logging in...');
            return await this.login(trimmedServer, trimmedUsername, trimmedPassword);
        }
        return true;
      } else {
        throw new Error('Server returned an error during registration');
      }
    } catch (error) {
      if (error.response?.status === 409) {
        throw new Error('Username already exists on this server');
      }
      
      let errorMessage = error.message;
      if (error.response?.data) {
        errorMessage = typeof error.response.data === 'string' 
            ? error.response.data 
            : JSON.stringify(error.response.data);
      }

      console.error('Registration error:', errorMessage);
      throw new Error(errorMessage || 'Failed to create account');
    }
  }

  async logout() {
    this.token = null;
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      // We keep serverUrl and username for convenience on next login
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
        // or if we're already showing an alert, or if the request is configured to skip auto-probing
        if (isNetworkError &&
            originalRequest &&
            !originalRequest._retry &&
            !originalRequest.skipAutoProbe &&
            !authService.isProbing &&
            !authService.isShowingProbeAlert) {
            authService.isShowingProbeAlert = true;

            return new Promise((resolve, reject) => {
                const attemptSilentFailover = async () => {
                    console.log('[AuthService] Network error, attempting silent dual-connection failover...');
                    const success = await authService.determineBestConnection();
                    if (success) {
                        originalRequest._retry = true;
                        const newBaseUrl = authService.getServerUrl();
                        
                        let relativePath = originalRequest.url;
                        if (relativePath.startsWith('http')) {
                            const match = relativePath.match(/^https?:\/\/[^\/]+(\/.*)$/);
                            relativePath = match ? match[1] : '/';
                        }
                        if (!relativePath.startsWith('/')) relativePath = '/' + relativePath;
                        
                        originalRequest.url = newBaseUrl + relativePath;
                        originalRequest.baseURL = newBaseUrl;
                        console.log(`[AuthService] Retrying request silently at: ${originalRequest.url}`);
                        try {
                            const resp = await axios(originalRequest);
                            resolve(resp);
                        } catch (e) {
                            reject(e);
                        }
                        return true;
                    }
                    return false;
                };

                attemptSilentFailover().then(success => {
                    if (success) return;
                    
                    authService.isShowingProbeAlert = true;
                    Alert.alert(
                        "Connection Lost",
                        "We couldn't reach your Lomorage server. Tap \"Re-scan\" to search for it on your local network.",
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
                                    const found = await authService.autoProbe();
                                    authService.isShowingProbeAlert = false;
                                    if (found) {
                                        originalRequest._retry = true;
                                        const newBaseUrl = authService.getServerUrl();
                                        
                                        let relativePath = originalRequest.url;
                                        if (relativePath.startsWith('http')) {
                                            const match = relativePath.match(/^https?:\/\/[^\/]+(\/.*)$/);
                                            relativePath = match ? match[1] : '/';
                                        }
                                        if (!relativePath.startsWith('/')) relativePath = '/' + relativePath;
                                        
                                        originalRequest.url = newBaseUrl + relativePath;
                                        originalRequest.baseURL = newBaseUrl;
                                        resolve(axios(originalRequest));
                                    } else {
                                        reject(error);
                                    }
                                }
                            }
                        ]
                    );
                });
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
            
            // Instantly log the user out so the screen transitions in the background
            if (authService._onSessionExpired) {
                authService._onSessionExpired();
            }

            Alert.alert(
                "Session Expired",
                "Your login session has expired. Please log in again to continue.",
                [
                    {
                        text: "OK",
                        onPress: () => {
                            authService._isShowingSessionAlert = false;
                        }
                    }
                ]
            );
        }
        return Promise.reject(error);
    }
);

export { formatServerUrl };
export default authService;

