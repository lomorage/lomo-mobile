import * as SecureStore from 'expo-secure-store';
import AuthService from '../../src/services/AuthService';
import { registerUser, startTestServer } from '../support/harness';

const server = startTestServer('auth');

describe('account lifecycle against lomod', () => {
  let alice;

  it('lists a writable disk on a brand-new server', async () => {
    const disks = await AuthService.getAvailableDisks(server.address);
    expect(disks.length).toBeGreaterThan(0);
    expect(disks[0].name).toBeTruthy();
  });

  it('registers the first account and logs in with it', async () => {
    alice = await registerUser(server);

    expect(AuthService.isAuthenticated()).toBe(true);
    expect(AuthService.getServerUrl()).toBe(server.url);
    expect(await SecureStore.getItemAsync('lomo_auth_token')).toBe(AuthService.getToken());
    expect(await SecureStore.getItemAsync('lomo_username')).toBe(alice.username);
  });

  it('reads the server version with the session token', async () => {
    expect(await AuthService.getServerVersion()).not.toBe('Unknown');
  });

  it('logs back in after logout with the argon2-hashed password', async () => {
    await AuthService.logout();
    expect(AuthService.getToken()).toBeNull();

    await AuthService.login(server.address, alice.username, alice.password);
    expect(AuthService.getToken()).toBeTruthy();
  });

  it('rejects a wrong password', async () => {
    await expect(AuthService.login(server.address, alice.username, 'not-the-password')).rejects.toThrow(
      'Invalid username or password',
    );
    await AuthService.login(server.address, alice.username, alice.password);
  });

  it('lets a signed-in user create a second account, but not a duplicate', async () => {
    await expect(registerUser(server, { username: 'bob', password: 'bob-pw-1' })).resolves.toBeTruthy();
    // register() auto-logs in as the new account.
    expect(await SecureStore.getItemAsync('lomo_username')).toBe('bob');

    const disks = await AuthService.getAvailableDisks(server.address);
    await expect(
      AuthService.register(server.address, 'bob', 'whatever-1', disks[0].name, '', false),
    ).rejects.toThrow();
  });

  it('deletes the signed-in account so it can no longer log in', async () => {
    await expect(AuthService.deleteAccount()).resolves.toBe(true);
    await expect(AuthService.login(server.address, 'bob', 'bob-pw-1')).rejects.toThrow();

    // The other account is untouched.
    await expect(AuthService.login(server.address, alice.username, alice.password)).resolves.toBe(true);
  });
});
