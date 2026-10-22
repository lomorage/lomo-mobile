// What was typed on Create Account. Survives the screen unmounting, so Back (which Android users
// press to hide the keyboard) doesn't wipe it, and lets Sign In reuse the address. Passwords are
// deliberately not kept.
let draft = { server: '', username: '' };

export const getRegisterDraft = () => draft;
export const setRegisterDraft = (next) => { draft = next; };
export const clearRegisterDraft = () => { draft = { server: '', username: '' }; };
