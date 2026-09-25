// On-device ML (embeddings, OCR, faces) is out of scope for backend integration
// tests; SyncService only kicks it off in the background after a sync.
module.exports = {
  __esModule: true,
  default: {
    isProcessing: false,
    processLocalEmbeddings: async () => {},
    syncEmbeddings: async () => {},
  },
};
