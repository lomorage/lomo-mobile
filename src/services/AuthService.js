import * as SecureStore from 'expo-secure-store';
import axios from 'axios';
import Argon2 from 'react-native-argon2';

axios.defaults.timeout = 10000; // Global 10s fallback to prevent native Java SocketTimeout popups

const TOKEN_KEY = 'lomo_auth_token';
const SERVER_KEY = 'lomo_server_url';
const USERNAME_KEY = 'lomo_username';

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
  }

  async init() {
    try {
      this.token = await SecureStore.getItemAsync(TOKEN_KEY);
      this.serverUrl = await SecureStore.getItemAsync(SERVER_KEY);
      return this.isAuthenticated();
    } catch (e) {
      console.error('Failed to initialize auth state', e);
      return false;
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

  async login(serverAddress, username, password) {
    if (!serverAddress || !username || !password) {
      throw new Error('Server, username, and password are required');
    }

    try {
      const url = serverAddress.startsWith('http') ? serverAddress : `http://${serverAddress}`;
      this.serverUrl = url;

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

  async logout() {
    this.token = null;
    this.serverUrl = null;
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(SERVER_KEY);
      // We keep username for convenience on next login
    } catch (e) {
      console.error('Error clearing secure store', e);
    }
  }
}

export default new AuthService();
