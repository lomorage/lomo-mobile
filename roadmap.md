# Lomorage Mobile Roadmap

## 🎯 Core Positioning
Lomorage is designed around three core pillars:
1. **Privacy-First & Self-Hosted**: Users have complete control over their personal data, stored entirely on their own hardware (NAS/Raspberry Pi/PC), without cloud vendor lock-in.
2. **On-Device AI**: Edge computing model where features like similarity search, text extraction, and deduplication run directly on the user's mobile device, preventing sensitive data from leaving the local network.
3. **Massive Gallery Management**: Optimized for huge galleries (18,000+ photos), utilizing Merkle trees for incremental sync and SQLite caching for lightning-fast UX.

---

## 🚀 Future Features

### 🤖 Cross-Platform AI Architecture Strategy (RN/Expo)
To replace legacy iOS-only native code (`lomo-ios`), we are adopting a modern, unified cross-platform approach for all on-device AI operations:
- **Core Semantic Search & Face Clustering**: Utilize `onnxruntime-react-native` to run lightweight ONNX models (e.g., CLIP for semantic search, MobileFaceNet for face recognition/clustering) directly on the edge. This provides an elegant, zero-native-code cross-platform solution.
- **Text Recognition & Detection**: Leverage `@infinitered/react-native-mlkit-text-recognition` (and related MLKit suites) for highly accurate, offline OCR and basic bounding-box detections, ensuring perfect Expo compatibility.


### 1. Intelligent Albums & Memories
- **Face Grouping**: On-device lightweight models to cluster family and friends.
- **Trip & Event Clustering**: Auto-generate albums based on GPS coordinates and time clusters.
- **On This Day (Memories)**: Automatically resurface old photos from the same day in past years.

### 2. Enhanced Search Experience
- **Interactive Map View**: A photo map wall/heatmap to visually browse media by global location.
- **OCR Search**: On-device text extraction from images (receipts, business cards, screenshots) for keyword search.
- **Multi-Condition Search**: Search by combining location, time, and AI semantic objects (e.g., "dog on the beach in Sanya").

### 3. Storage & Sync Optimization
- **Smart Free Up Space (Large File Cleanup)**: [Ongoing] Review and auto-delete massive local files (like heavy videos) that are already securely backed up to the NAS.
- **AI-Driven Smart Declutter**: Let the backend PC/NAS run AI scoring during idle times to categorize photos (e.g. low-value receipts vs high-value family portraits). The mobile app syncs these scores and automatically deletes low-value local originals, compresses medium-value photos to 50KB offline thumbnails, and unconditionally retains high-value originals to eliminate offline viewing anxiety.
- **Family & Guest Spaces**: Multi-account isolation under the same NAS and shared family albums.
- **Secure Guest Links**: Generate secure, temporary web links (via tunneling) to share specific albums with non-users.

### 4. Editing & AI Enhancements
- **Duplicate Cleanup UI**: Leverage existing pHash data to provide an intuitive interface for cleaning up similar photos/burst shots.
- **Basic Photo Editing**: Built-in crop, rotate, and filtering, automatically synced as new versions to the NAS.
