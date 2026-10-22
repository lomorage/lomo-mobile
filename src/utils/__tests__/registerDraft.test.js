import { getRegisterDraft, setRegisterDraft, clearRegisterDraft } from '../registerDraft';

afterEach(clearRegisterDraft);

test('starts blank, remembers what was set, and can be cleared', () => {
  expect(getRegisterDraft()).toEqual({ server: '', username: '' });
  setRegisterDraft({ server: '10.0.0.219:8000', username: 'sarah' });
  expect(getRegisterDraft()).toEqual({ server: '10.0.0.219:8000', username: 'sarah' });
  clearRegisterDraft();
  expect(getRegisterDraft()).toEqual({ server: '', username: '' });
});
