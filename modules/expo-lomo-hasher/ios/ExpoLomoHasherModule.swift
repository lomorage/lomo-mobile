import ExpoModulesCore
import CryptoKit
import Foundation
import Photos

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
  }

  /// Hashes a Photos library asset referenced by a ph:// URI.
  /// Streams the asset bytes via PHAssetResourceManager to keep memory flat.
  private func hashPhotosAsset(uriString: String, promise: Promise) {
    // Extract local identifier: "ph://IDENTIFIER/L0/001" -> "IDENTIFIER"
    let withoutScheme = uriString.replacingOccurrences(of: "ph://", with: "")
    let localIdentifier = withoutScheme.components(separatedBy: "/").first ?? ""

    guard !localIdentifier.isEmpty else {
      promise.reject("INVALID_URI", "Could not parse Photos identifier from: \(uriString)")
      return
    }

    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
    guard let asset = fetchResult.firstObject else {
      promise.reject("ERR_ASSET_NOT_FOUND", "Photos asset not found for identifier: \(localIdentifier)")
      return
    }

    // Pick the best available resource (prefer original photo/video data)
    let resources = PHAssetResource.assetResources(for: asset)
    let preferred: [PHAssetResourceType] = [.photo, .fullSizePhoto, .video, .fullSizeVideo, .pairedVideo, .audio]
    guard let resource = resources.first(where: { preferred.contains($0.type) }) ?? resources.first else {
      promise.reject("ERR_NO_RESOURCE", "No readable resource for Photos asset: \(localIdentifier)")
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
}
