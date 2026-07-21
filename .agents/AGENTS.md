# Agent Rules

- 在本项目中编写代码时，所有的 UI 文案、Log 日志和代码注释都必须使用英文，绝对不要使用中文。

## Lomo-backend Preview Sizes
- **ALWAYS** request exact pre-generated sizes from `lomo-backend` to prevent dynamic transcoding:
  - Image Thumbnail: `width=320`
  - Image Large Preview: `width=640` 
  - Video Thumbnail: `width=480`
- Do NOT use hardcoded widths like `512` or `1280` when requesting `/preview/` endpoints. Use the centralized helper `MediaService.getPreviewUrl(hash, mediaType, isLarge)` if available.

## Prevent ANR and JS Thread Blocking
- **NEVER** block the JS thread with large synchronous tasks. This is especially critical when interacting with JSI APIs like `expo-sqlite`'s `executeSync`.
- When doing bulk database inserts/updates, strictly cap the chunk size at `50` (i.e. `chunkSize = 50;`).
- Always yield back to the JS event loop AND check for UI idleness between chunks to prevent ANRs using `TaskSchedulerService.waitUntilIdle()` alongside a small timeout.
- Example pattern:
```javascript
for (let i = 0; i < assets.length; i += chunkSize) {
  // ... db insert chunk
  if (i + chunkSize < assets.length) {
    await new Promise(resolve => setTimeout(resolve, 5));
    await TaskSchedulerService.waitUntilIdle();
  }
}
```
