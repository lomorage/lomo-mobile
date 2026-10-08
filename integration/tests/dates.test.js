import AuthService from '../../src/services/AuthService';
import UploadService from '../../src/services/UploadService';
import { addToCameraRoll, fixturePath } from '../support/cameraRoll';
import { registerUser, sha1, startTestServer } from '../support/harness';

const server = startTestServer('dates');

async function serverDate(hash) {
  const res = await fetch(`${server.url}/asset/${hash}?info=1`, {
    headers: { Authorization: `token=${AuthService.getToken()}` },
  });
  expect(res.status).toBe(200);
  return JSON.stringify(await res.json());
}

describe('the date a photo is filed under on the computer', () => {
  beforeAll(async () => {
    await registerUser(server);
  });

  it('uses the photo\'s own EXIF date when the phone does not know when it was taken', async () => {
    // Android reports no DATE_TAKEN for photos whose EXIF date has no time zone; expo gives 0.
    const photo = addToCameraRoll('photo-2003-11-23.jpg', { creationTime: 0 });

    const result = await UploadService.uploadAsset(photo);

    expect(result).toMatchObject({ success: true });
    const info = await serverDate(sha1(fixturePath('photo-2003-11-23.jpg')));
    expect(info).toContain('2003-11-23');
    expect(info).not.toMatch(new RegExp(String(new Date().getUTCFullYear())));
  });

  it('uses the time the phone reports when it has one', async () => {
    const photo = addToCameraRoll('photo-2003-11-01.jpg', { creationTime: Date.UTC(2010, 5, 15, 12) });

    await UploadService.uploadAsset(photo);

    expect(await serverDate(sha1(fixturePath('photo-2003-11-01.jpg')))).toContain('2010-06-15');
  });
});
