import ExpoModulesCore
import CryptoKit
import Foundation
import Photos
import Zip

public class ExpoLomoHasherModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoLomoHasher")

    AsyncFunction("hashFileAsync") { (uriString: String, promise: Promise) in
      // Handle ph:// URIs (iOS Photos library assets, e.g. "ph://IDENTIFIER/L0/001")
      if uriString.hasPrefix("ph://") {
        self.hashPhotosAsset(uriString: uriString, promise: promise)
        return
      }

      // Handle file:// and raw file paths
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let url: URL
          if uriString.hasPrefix("file://") {
            guard let parsed = URL(string: uriString) else {
              promise.reject("INVALID_URI", "Invalid URI string: \(uriString)")
              return
            }
            url = parsed
          } else {
            url = URL(fileURLWithPath: uriString)
          }

          guard FileManager.default.isReadableFile(atPath: url.path) else {
            promise.reject("ERR_FILE_NOT_READABLE", "File is not readable: \(url.path)")
            return
          }

          let fileHandle = try FileHandle(forReadingFrom: url)
          defer { try? fileHandle.close() }

          var hasher = Insecure.SHA1()
          let bufferSize = 1024 * 1024 // 1MB chunks

          while autoreleasepool(invoking: {
            let data = fileHandle.readData(ofLength: bufferSize)
            if !data.isEmpty {
              hasher.update(data: data)
              return true
            }
            return false
          }) {}

          let digest = hasher.finalize()
          let hexString = digest.map { String(format: "%02x", $0) }.joined()
          promise.resolve(hexString)
        } catch {
          promise.reject("HASH_ERROR", error.localizedDescription)
        }
      }
    }

    AsyncFunction("isLivePhotoAsync") { (uriString: String, promise: Promise) in
      guard uriString.hasPrefix("ph://") else {
        promise.resolve(false)
        return
      }
      
      guard let asset = self.getPHAsset(from: uriString) else {
        promise.resolve(false)
        return
      }
      
      promise.resolve(asset.mediaSubtypes.contains(.photoLive))
    }

    AsyncFunction("prepareLivePhotoBackupAsync") { (uriString: String, promise: Promise) in
      guard uriString.hasPrefix("ph://") else {
        promise.reject("INVALID_URI", "Only ph:// URIs are supported for Live Photos.")
        return
      }

      guard let asset = self.getPHAsset(from: uriString) else {
        promise.reject("ERR_ASSET_NOT_FOUND", "Photos asset not found for identifier: \(uriString)")
        return
      }

      guard asset.mediaSubtypes.contains(.photoLive) else {
        promise.reject("ERR_NOT_A_LIVE_PHOTO", "Asset is not a Live Photo.")
        return
      }

      let resources = PHAssetResource.assetResources(for: asset)
      var imageResource: PHAssetResource?
      var videoResource: PHAssetResource?
      for res in resources {
        if res.type == .photo || res.type == .fullSizePhoto {
          imageResource = res
        } else if res.type == .pairedVideo || res.type == .fullSizePairedVideo || res.type == .video {
          videoResource = res
        }
      }

      guard let imageRes = imageResource, let videoRes = videoResource else {
        promise.reject("ERR_RESOURCES_MISSING", "Could not locate both image and motion video resources for Live Photo.")
        return
      }

      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let zipDirName = self.sha1String(from: asset.localIdentifier) ?? UUID().uuidString
          let zipFileName = "\(zipDirName).zip"
          
          let tempDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(zipDirName)
          let zipFilePath = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(zipFileName)
          
          try? FileManager.default.removeItem(at: tempDir)
          try? FileManager.default.removeItem(at: zipFilePath)
          try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: nil)
          
          defer {
            try? FileManager.default.removeItem(at: tempDir)
          }

          // Fetch resources synchronously on background queue
          let imageTmpUrl = try self.fetchLocalAssetSync(for: imageRes, to: tempDir)
          let videoTmpUrl = try self.fetchLocalAssetSync(for: videoRes, to: tempDir)
          
          // Calculate hashes
          let imageHash = try self.calculateSHA1(of: imageTmpUrl)
          let videoHash = try self.calculateSHA1(of: videoTmpUrl)
          
          // Combined hash
          let combinedString = imageHash + videoHash
          var combinedHasher = Insecure.SHA1()
          if let data = combinedString.data(using: .utf8) {
            combinedHasher.update(data: data)
          }
          let combinedHash = combinedHasher.finalize().map { String(format: "%02x", $0) }.joined()
          
          // Comment payload expected by Lomorage server
          let commentHash = "{\"image_sha1\": \"\(imageHash)\", \"video_sha1\": \"\(videoHash)\", \"total_sha1\": \"\(combinedHash)\"}"
          
          // Create zip file
          try Zip.zipFiles(
            paths: [imageTmpUrl, videoTmpUrl],
            zipFilePath: zipFilePath,
            password: nil,
            progress: nil
          )
          
          // Write the JSON metadata comment directly to the ZIP file EOCD record
          try self.writeZipComment(to: zipFilePath, comment: commentHash)
          
          promise.resolve([
            "uri": zipFilePath.absoluteString,
            "hash": combinedHash,
            "imageHash": imageHash,
            "videoHash": videoHash,
            "filename": "\(combinedHash).zip"
          ])
        } catch {
          promise.reject("ZIP_FAILED", "Failed to package Live Photo: \(error.localizedDescription)")
        }
      }
    }
  }

  /// Extracts the local identifier and fetches a PHAsset.
  private func getPHAsset(from uriString: String) -> PHAsset? {
    let withoutScheme = uriString.replacingOccurrences(of: "ph://", with: "")
    let localIdentifier = withoutScheme.components(separatedBy: "/").first ?? ""
    guard !localIdentifier.isEmpty else { return nil }
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
    return fetchResult.firstObject
  }

  /// Hashes a Photos library asset referenced by a ph:// URI.
  /// Streams the asset bytes via PHAssetResourceManager to keep memory flat.
  private func hashPhotosAsset(uriString: String, promise: Promise) {
    guard let asset = self.getPHAsset(from: uriString) else {
      promise.reject("ERR_ASSET_NOT_FOUND", "Photos asset not found for identifier: \(uriString)")
      return
    }

    // Pick the best available resource (prefer original photo/video data)
    let resources = PHAssetResource.assetResources(for: asset)
    let preferred: [PHAssetResourceType] = [.photo, .fullSizePhoto, .video, .fullSizeVideo, .pairedVideo, .audio]
    guard let resource = resources.first(where: { preferred.contains($0.type) }) ?? resources.first else {
      promise.reject("ERR_NO_RESOURCE", "No readable resource for Photos asset: \(uriString)")
      return
    }

    var hasher = Insecure.SHA1()
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = false // Do not trigger iCloud download

    PHAssetResourceManager.default().requestData(
      for: resource,
      options: options,
      dataReceivedHandler: { chunk in
        // Called repeatedly with successive chunks — perfect for streaming hash
        hasher.update(data: chunk)
      },
      completionHandler: { error in
        if let error = error {
          promise.reject("HASH_ERROR", "Photos asset hash failed: \(error.localizedDescription)")
          return
        }
        let digest = hasher.finalize()
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        promise.resolve(hex)
      }
    )
  }

  /// Synchronously fetches a PHAssetResource to the local temporary directory.
  private func fetchLocalAssetSync(for resource: PHAssetResource, to tempDir: URL) throws -> URL {
    let assetTmpPath = tempDir.appendingPathComponent(resource.originalFilename)
    try? FileManager.default.removeItem(at: assetTmpPath)
    
    let semaphore = DispatchSemaphore(value: 0)
    var fetchError: Error?
    
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true // Allow iCloud download, matching lomo-ios
    
    PHAssetResourceManager.default().writeData(for: resource, toFile: assetTmpPath, options: options) { error in
      fetchError = error
      semaphore.signal()
    }
    
    _ = semaphore.wait(timeout: .distantFuture)
    
    if let error = fetchError {
      throw error
    }
    
    return assetTmpPath
  }

  /// Helper to calculate flat-memory SHA1 hash of a local file URL.
  private func calculateSHA1(of url: URL) throws -> String {
    let fileHandle = try FileHandle(forReadingFrom: url)
    defer { try? fileHandle.close() }
    
    var hasher = Insecure.SHA1()
    let bufferSize = 1024 * 1024
    
    while autoreleasepool(invoking: {
      let data = fileHandle.readData(ofLength: bufferSize)
      if !data.isEmpty {
        hasher.update(data: data)
        return true
      }
      return false
    }) {}
    
    let digest = hasher.finalize()
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  /// Calculates sha1 of a string.
  private func sha1String(from string: String) -> String? {
    guard let data = string.data(using: .utf8) else { return nil }
    var hasher = Insecure.SHA1()
    hasher.update(data: data)
    let digest = hasher.finalize()
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  /// Appends or updates the EOCD ZIP comment record directly in the ZIP archive.
  private func writeZipComment(to zipURL: URL, comment: String) throws {
    let fileHandle = try FileHandle(forUpdating: zipURL)
    defer { try? fileHandle.close() }
    
    let fileSize = try fileHandle.seekToEnd()
    guard fileSize >= 22 else {
      throw NSError(domain: "ZipCommentError", code: 1, userInfo: [NSLocalizedDescriptionKey: "File too small for ZIP archive"])
    }
    
    let readSize = min(fileSize, 1024)
    try fileHandle.seek(toOffset: fileSize - readSize)
    let data = fileHandle.readData(ofLength: Int(readSize))
    
    // EOCD signature is 0x06054b50 (little endian: 50 4b 05 06)
    let eocdSignature: [UInt8] = [0x50, 0x4b, 0x05, 0x06]
    
    var eocdOffset: Int? = nil
    for i in stride(from: data.count - 22, through: 0, by: -1) {
      if data[i] == eocdSignature[0] &&
         data[i+1] == eocdSignature[1] &&
         data[i+2] == eocdSignature[2] &&
         data[i+3] == eocdSignature[3] {
        let commentLengthOffset = i + 20
        let commentLength = UInt16(data[commentLengthOffset]) | (UInt16(data[commentLengthOffset + 1]) << 8)
        if fileSize - (fileSize - readSize + UInt64(i)) == 22 + UInt64(commentLength) {
          eocdOffset = Int(fileSize - readSize) + i
          break
        }
      }
    }
    
    guard let offset = eocdOffset else {
      throw NSError(domain: "ZipCommentError", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not locate End of Central Directory (EOCD) in ZIP"])
    }
    
    guard let commentData = comment.data(using: .utf8) else {
      throw NSError(domain: "ZipCommentError", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to convert comment to UTF-8 data"])
    }
    
    let commentLength = UInt16(commentData.count)
    var lengthBytes = [UInt8](repeating: 0, count: 2)
    lengthBytes[0] = UInt8(commentLength & 0xFF)
    lengthBytes[1] = UInt8((commentLength >> 8) & 0xFF)
    
    try fileHandle.seek(toOffset: UInt64(offset + 20))
    fileHandle.write(Data(lengthBytes))
    try fileHandle.seek(toOffset: UInt64(offset + 22))
    fileHandle.write(commentData)
    
    let finalSize = try fileHandle.offset()
    try fileHandle.truncate(atOffset: finalSize)
  }
}
