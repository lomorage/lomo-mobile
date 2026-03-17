# Lomorage Mobile

React Native / Expo client for Lomorage.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm start
   ```

3. Run on Android / iOS (requires native build):
   ```bash
   npx expo run:android
   # or
   npx expo run:ios
   ```

## Testing

The project uses Jest for unit testing, covering crucial logic like the Merkle Tree synchronization (`SyncService.js`) and Media Hashing (`MediaService.js`).

To run all unit tests:
```bash
npm test
```

To run a specific test file:
```bash
npx jest src/services/__tests__/MerkleTree.test.js
```
