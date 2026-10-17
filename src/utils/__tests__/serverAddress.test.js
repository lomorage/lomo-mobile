import { isCompleteServerAddress } from '../serverAddress';

describe('isCompleteServerAddress', () => {
  test.each([
    '10.0.0.219:8000',
    '192.168.1.100',
    '192.168.1.100:80',
    'localhost:8000',
    'nas.local',
    'nas.local:8000',
    'photos.example.com',
    'photos.example.com:443',
    'http://10.0.0.219:8000',
    'https://photos.example.com/',
    ' 10.0.0.219:8000 ',
  ])('%s is complete', (text) => {
    expect(isCompleteServerAddress(text)).toBe(true);
  });

  test.each([
    '',
    '   ',
    '1',
    '10.',
    '10.0.0',
    '10.0.0.2.',
    '10.0.0.219:', // port not typed yet
    '10.0.0.219:80000', // not a port
    '10.0.0.219:0',
    '10.0.0.219:80a',
    '10.0.0.256', // not an IPv4 address
    '-bad.example.com',
    'has space.local',
  ])('%j is not complete', (text) => {
    expect(isCompleteServerAddress(text)).toBe(false);
  });

  test('while typing an address, the half-typed port and the unfinished IP are never complete', () => {
    const typed = '10.0.0.219:8000';
    const complete = [];
    for (let i = 1; i <= typed.length; i += 1) {
      if (isCompleteServerAddress(typed.slice(0, i))) complete.push(typed.slice(0, i));
    }
    // "10.0.0.219" and "10.0.0.219:8" are valid on their own, so this check alone cannot
    // stop them: the debounce in RegisterScreen is what keeps them from being contacted.
    expect(complete).toContain(typed);
    expect(complete).not.toContain('10.0.0.219:');
    expect(complete).not.toContain('10.0.0');
  });
});
