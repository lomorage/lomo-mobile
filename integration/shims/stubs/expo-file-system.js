// The new (non-legacy) expo-file-system API is only touched by utils/logger's
// disk flush, which integration tests never trigger.
class File {
  constructor(...uris) {
    this.uri = uris.join('/');
  }
}
class Directory extends File {}

module.exports = { File, Directory, Paths: {} };
