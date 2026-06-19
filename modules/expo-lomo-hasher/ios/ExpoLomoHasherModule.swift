import ExpoModulesCore
import CryptoKit
import Foundation
import Photos
import Zip
import onnxruntime_objc
import UIKit

public class ExpoLomoHasherModule: Module {
  private var visualSession: ORTSession?
  private var textualSession: ORTSession?
  private var ortEnv: ORTEnv?
  private var clipTokenizer: ClipTokenizer?

  private func getOrtEnv() throws -> ORTEnv {
    if let env = ortEnv { return env }
    let env = try ORTEnv(loggingLevel: .warning)
    ortEnv = env
    return env
  }

  private func getResourcePath(name: String, ext: String) -> String? {
    if let path = Bundle(for: ExpoLomoHasherModule.self).path(forResource: name, ofType: ext) {
      return path
    }
    if let path = Bundle.main.path(forResource: name, ofType: ext) {
      return path
    }
    if let bundle = Bundle(identifier: "org.cocoapods.ExpoLomoHasher"),
       let path = bundle.path(forResource: name, ofType: ext) {
      return path
    }
    return nil
  }

  private func resolveModelPath(modelPath: String) throws -> String {
    if modelPath.contains("/") || modelPath.contains("\\") {
      return modelPath
    }
    let name = (modelPath as NSString).deletingPathExtension
    let ext = (modelPath as NSString).pathExtension
    guard let path = getResourcePath(name: name, ext: ext) else {
      throw NSError(domain: "ExpoLomoHasher", code: 4, userInfo: [NSLocalizedDescriptionKey: "Resource not found: \(modelPath)"])
    }
    return path
  }

  private func getVisualSession(modelPath: String) throws -> ORTSession {
    if let session = visualSession { return session }
    let env = try getOrtEnv()
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(2)
    let resolved = try resolveModelPath(modelPath: modelPath)
    let session = try ORTSession(env: env, modelPath: resolved, sessionOptions: options)
    visualSession = session
    return session
  }

  private func getTextualSession(modelPath: String) throws -> ORTSession {
    if let session = textualSession { return session }
    let env = try getOrtEnv()
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(2)
    let resolved = try resolveModelPath(modelPath: modelPath)
    let session = try ORTSession(env: env, modelPath: resolved, sessionOptions: options)
    textualSession = session
    return session
  }

  private func getTokenizer(vocabPath: String, mergesPath: String) throws -> ClipTokenizer {
    if let tokenizer = clipTokenizer { return tokenizer }
    let resolvedVocab = try resolveModelPath(modelPath: vocabPath)
    let resolvedMerges = try resolveModelPath(modelPath: mergesPath)
    let tokenizer = try ClipTokenizer(vocabPath: resolvedVocab, mergesPath: resolvedMerges)
    clipTokenizer = tokenizer
    return tokenizer
  }

  private func centerCropAndResize(image: UIImage, targetSize: CGFloat) -> UIImage? {
    let sourceSize = image.size
    let cropSize = min(sourceSize.width, sourceSize.height)
    let cropRect = CGRect(
        x: (sourceSize.width - cropSize) / 2.0,
        y: (sourceSize.height - cropSize) / 2.0,
        width: cropSize,
        height: cropSize
    )
    guard let cgImage = image.cgImage?.cropping(to: cropRect) else { return nil }
    
    let size = CGSize(width: targetSize, height: targetSize)
    UIGraphicsBeginImageContextWithOptions(size, false, 1.0)
    UIImage(cgImage: cgImage).draw(in: CGRect(origin: .zero, size: size))
    let resizedImage = UIGraphicsGetImageFromCurrentImageContext()
    UIGraphicsEndImageContext()
    return resizedImage
  }

  private func preprocessImage(image: UIImage) -> Data? {
    guard let cgImage = image.cgImage else { return nil }
    let width = 224
    let height = 224
    
    var pixelBuffer = [UInt8](repeating: 0, count: width * height * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: &pixelBuffer,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    ) else { return nil }
    
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    
    var floatBuffer = [Float](repeating: 0.0, count: 1 * 3 * width * height)
    let stride = width * height
    
    for i in 0..<height {
        for j in 0..<width {
            let offset = (i * width + j) * 4
            let r = Float(pixelBuffer[offset]) / 255.0
            let g = Float(pixelBuffer[offset + 1]) / 255.0
            let b = Float(pixelBuffer[offset + 2]) / 255.0
            
            let idx = i * width + j
            floatBuffer[idx] = (r - 0.48145467) / 0.26862955
            floatBuffer[idx + stride] = (g - 0.4578275) / 0.2613026
            floatBuffer[idx + stride * 2] = (b - 0.40821072) / 0.2757771
        }
    }
    
    return Data(bytes: floatBuffer, count: floatBuffer.count * MemoryLayout<Float>.size)
  }

  private func normalizeL2(_ inputArray: [Float]) -> [Float] {
    var norm: Float = 0.0
    for val in inputArray {
        norm += val * val
    }
    norm = sqrt(norm)
    if norm == 0.0 { return inputArray }
    return inputArray.map { $0 / norm }
  }

  private func floatArrayToBase64(_ floats: [Float]) -> String {
    let size = floats.count * MemoryLayout<Float>.size
    let data = Data(bytes: floats, count: size)
    return data.base64EncodedString()
  }

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

    AsyncFunction("getLocalLivePhotoVideoUriAsync") { (uriString: String, promise: Promise) in
      guard uriString.hasPrefix("ph://") else {
        promise.reject("INVALID_URI", "Only ph:// URIs are supported.")
        return
      }
      
      guard let asset = self.getPHAsset(from: uriString) else {
        promise.reject("ERR_ASSET_NOT_FOUND", "Asset not found.")
        return
      }
      
      let resources = PHAssetResource.assetResources(for: asset)
      var videoResource: PHAssetResource?
      for res in resources {
        if res.type == .pairedVideo || res.type == .fullSizePairedVideo || res.type == .video {
          videoResource = res
          break
        }
      }
      
      guard let videoRes = videoResource else {
        promise.reject("ERR_VIDEO_RESOURCE_NOT_FOUND", "No paired video component found.")
        return
      }
      
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let cleanId = self.sanitizeIdentifier(asset.localIdentifier)
          let tempDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(cleanId)
          try? FileManager.default.removeItem(at: tempDir)
          try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: nil)
          
          let videoTmpUrl = try self.fetchLocalAssetSync(for: videoRes, to: tempDir)
          
          // Copy it directly to Caches directory!
          let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
          let destVideoUrl = cachesDir.appendingPathComponent("\(cleanId).mov")
          try? FileManager.default.removeItem(at: destVideoUrl)
          try FileManager.default.copyItem(at: videoTmpUrl, to: destVideoUrl)
          try? FileManager.default.removeItem(at: tempDir)
          
          promise.resolve(destVideoUrl.absoluteString)
        } catch {
          promise.reject("ERR_FETCH_FAILED", "Failed to fetch video: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("extractVideoFromZipAsync") { (zipUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let zipUrl: URL
          if zipUri.hasPrefix("file://") {
            guard let parsed = URL(string: zipUri) else {
              promise.reject("INVALID_URI", "Invalid ZIP URI: \(zipUri)")
              return
            }
            zipUrl = parsed
          } else {
            zipUrl = URL(fileURLWithPath: zipUri)
          }

          let zipDirName = zipUrl.deletingPathExtension().lastPathComponent
          let tempDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(zipDirName)
          
          try? FileManager.default.removeItem(at: tempDir)
          try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: nil)
          
          // Unzip the file
          try Zip.unzipFile(zipUrl, destination: tempDir, overwrite: true, password: nil)
          
          // Find any file ending with .mov or .mp4 or other video extensions
          let allFiles = try FileManager.default.contentsOfDirectory(at: tempDir, includingPropertiesForKeys: nil)
          var videoUrl: URL? = nil
          for file in allFiles {
            let ext = file.pathExtension.lowercased()
            if ["mov", "mp4", "m4v"].contains(ext) {
              videoUrl = file
              break
            }
          }
          
          if let foundVideo = videoUrl {
            // Copy it directly to Caches directory!
            let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            let destVideoUrl = cachesDir.appendingPathComponent("\(zipDirName).mov")
            try? FileManager.default.removeItem(at: destVideoUrl)
            try FileManager.default.copyItem(at: foundVideo, to: destVideoUrl)
            try? FileManager.default.removeItem(at: tempDir) // cleanup zip folder
            
            promise.resolve(destVideoUrl.absoluteString)
          } else {
            promise.reject("ERR_NO_VIDEO", "No video component found inside Live Photo zip.")
          }
        } catch {
          promise.reject("UNZIP_FAILED", "Failed to extract video: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("sliceFileAsync") { (sourceUri: String, destUri: String, offset: Int64, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let sourceUrl: URL
          if sourceUri.hasPrefix("file://") {
            guard let url = URL(string: sourceUri) else {
              promise.reject("INVALID_URI", "Invalid source URI: \(sourceUri)")
              return
            }
            sourceUrl = url
          } else {
            sourceUrl = URL(fileURLWithPath: sourceUri)
          }

          let destUrl: URL
          if destUri.hasPrefix("file://") {
            guard let url = URL(string: destUri) else {
              promise.reject("INVALID_URI", "Invalid destination URI: \(destUri)")
              return
            }
            destUrl = url
          } else {
            destUrl = URL(fileURLWithPath: destUri)
          }

          guard FileManager.default.isReadableFile(atPath: sourceUrl.path) else {
            promise.reject("ERR_FILE_NOT_READABLE", "Source file not readable: \(sourceUrl.path)")
            return
          }

          let destDir = destUrl.deletingLastPathComponent()
          try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true, attributes: nil)

          try? FileManager.default.removeItem(at: destUrl)
          FileManager.default.createFile(atPath: destUrl.path, contents: nil, attributes: nil)

          let sourceHandle = try FileHandle(forReadingFrom: sourceUrl)
          defer { try? sourceHandle.close() }

          let destHandle = try FileHandle(forWritingTo: destUrl)
          defer { try? destHandle.close() }

          try sourceHandle.seek(toOffset: UInt64(offset))

          let bufferSize = 1024 * 1024 // 1MB chunks
          while autoreleasepool(invoking: {
            let data = sourceHandle.readData(ofLength: bufferSize)
            if !data.isEmpty {
              destHandle.write(data)
              return true
            }
            return false
          }) {}

          promise.resolve(true)
        } catch {
          promise.reject("SLICE_ERROR", "Failed to slice file: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("encodeImageEmbeddingAsync") { (imageUriString: String, modelPath: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let image: UIImage
          if imageUriString.hasPrefix("ph://") {
            guard let asset = self.getPHAsset(from: imageUriString) else {
              promise.reject("ERR_ASSET_NOT_FOUND", "Asset not found: \(imageUriString)")
              return
            }
            
            let manager = PHImageManager.default()
            let options = PHImageRequestOptions()
            options.isSynchronous = true
            options.isNetworkAccessAllowed = true
            
            var fetchedImage: UIImage?
            manager.requestImage(for: asset, targetSize: CGSize(width: 320, height: 320), contentMode: .aspectFill, options: options) { img, _ in
              fetchedImage = img
            }
            guard let img = fetchedImage else {
              promise.reject("ERR_IMAGE_FETCH", "Failed to fetch image: \(imageUriString)")
              return
            }
            image = img
          } else {
            let url: URL
            if imageUriString.hasPrefix("file://") {
              guard let parsed = URL(string: imageUriString) else {
                promise.reject("INVALID_URI", "Invalid URI: \(imageUriString)")
                return
              }
              url = parsed
            } else {
              url = URL(fileURLWithPath: imageUriString)
            }
            guard let img = UIImage(contentsOfFile: url.path) else {
              promise.reject("ERR_IMAGE_LOAD", "Failed to load image from path: \(url.path)")
              return
            }
            image = img
          }
          
          guard let cropped = self.centerCropAndResize(image: image, targetSize: 224) else {
            promise.reject("ERR_PREPROCESS", "Center crop failed")
            return
          }
          guard let inputData = self.preprocessImage(image: cropped) else {
            promise.reject("ERR_PREPROCESS", "Preprocess image failed")
            return
          }
          
          let session = try self.getVisualSession(modelPath: modelPath)
          let shape: [NSNumber] = [1, 3, 224, 224]
          let inputTensor = try ORTValue(tensorData: NSMutableData(data: inputData), elementType: .float, shape: shape)
          
          let outputNames = try session.outputNames()
          let outputs = try session.run(withInputs: ["pixel_values": inputTensor], outputNames: outputNames, runOptions: nil)
          guard let firstOutputName = outputNames.first, let outputVal = outputs[firstOutputName] else {
            promise.reject("ERR_INFERENCE", "Output not found")
            return
          }
          
          let outputData = try outputVal.tensorData()
          let count = outputData.count / MemoryLayout<Float>.size
          var floats = [Float](repeating: 0.0, count: count)
          outputData.copyBytes(to: UnsafeMutableBufferPointer(start: &floats, count: count))
          
          let normalized = self.normalizeL2(floats)
          let base64 = self.floatArrayToBase64(normalized)
          promise.resolve(base64)
        } catch {
          promise.reject("ERR_IMAGE_EMBEDDING", error.localizedDescription)
        }
      }
    }

    AsyncFunction("encodeTextEmbeddingAsync") { (text: String, modelPath: String, vocabPath: String, mergesPath: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let tokenizer = try self.getTokenizer(vocabPath: vocabPath, mergesPath: mergesPath)
          let session = try self.getTextualSession(modelPath: modelPath)
          
          let tokenBOS: Int32 = 49406
          let tokenEOS: Int32 = 49407
          
          let queryFilter = try NSRegularExpression(pattern: "[^A-Za-z0-9 ]", options: [])
          let textClean = queryFilter.stringByReplacingMatches(
            in: text,
            options: [],
            range: NSRange(location: 0, length: text.utf16.count),
            withTemplate: ""
          ).lowercased()
          
          var tokens = [Int32]()
          tokens.append(tokenBOS)
          tokens.append(contentsOf: tokenizer.tokenize(text: textClean))
          tokens.append(tokenEOS)
          
          var mask = [Int32]()
          for _ in tokens {
              mask.append(1)
          }
          while tokens.count < 77 {
              tokens.append(0)
              mask.append(0)
          }
          
          let tokensFinal = Array(tokens.prefix(77))
          let maskFinal = Array(mask.prefix(77))
          
          let shape: [NSNumber] = [1, 77]
          
          let tokenData = Data(bytes: tokensFinal, count: 77 * MemoryLayout<Int32>.size)
          let maskData = Data(bytes: maskFinal, count: 77 * MemoryLayout<Int32>.size)
          
          let inputIdsTensor = try ORTValue(tensorData: NSMutableData(data: tokenData), elementType: .int32, shape: shape)
          let attentionMaskTensor = try ORTValue(tensorData: NSMutableData(data: maskData), elementType: .int32, shape: shape)
          
          let inputMap: [String: ORTValue] = [
            "input_ids": inputIdsTensor,
            "attention_mask": attentionMaskTensor
          ]
          
          let outputNames = try session.outputNames()
          let outputs = try session.run(withInputs: inputMap, outputNames: outputNames, runOptions: nil)
          guard let firstOutputName = outputNames.first, let outputVal = outputs[firstOutputName] else {
            promise.reject("ERR_INFERENCE", "Output not found")
            return
          }
          
          let outputData = try outputVal.tensorData()
          let count = outputData.count / MemoryLayout<Float>.size
          var floats = [Float](repeating: 0.0, count: count)
          outputData.copyBytes(to: UnsafeMutableBufferPointer(start: &floats, count: count))
          
          let normalized = self.normalizeL2(floats)
          let base64 = self.floatArrayToBase64(normalized)
          promise.resolve(base64)
        } catch {
          promise.reject("ERR_TEXT_EMBEDDING", error.localizedDescription)
        }
      }
    }

    AsyncFunction("generatePHashAsync") { (imageUriString: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let image: UIImage
          if imageUriString.hasPrefix("ph://") {
            guard let asset = self.getPHAsset(from: imageUriString) else {
              promise.reject("ERR_ASSET_NOT_FOUND", "Asset not found: \(imageUriString)")
              return
            }
            
            let manager = PHImageManager.default()
            let options = PHImageRequestOptions()
            options.isSynchronous = true
            options.isNetworkAccessAllowed = true
            
            var fetchedImage: UIImage?
            manager.requestImage(for: asset, targetSize: CGSize(width: 128, height: 128), contentMode: .aspectFill, options: options) { img, _ in
              fetchedImage = img
            }
            guard let img = fetchedImage else {
              promise.reject("ERR_IMAGE_FETCH", "Failed to fetch image: \(imageUriString)")
              return
            }
            image = img
          } else {
            let url: URL
            if imageUriString.hasPrefix("file://") {
              guard let parsed = URL(string: imageUriString) else {
                promise.reject("INVALID_URI", "Invalid URI: \(imageUriString)")
                return
              }
              url = parsed
            } else {
              url = URL(fileURLWithPath: imageUriString)
            }
            guard let data = try? Data(contentsOf: url), let img = UIImage(data: data) else {
              promise.reject("ERR_IMAGE_LOAD", "Failed to load image from: \(imageUriString)")
              return
            }
            image = img
          }
          
          // 1. Resize to 32x32
          let size = CGSize(width: 32, height: 32)
          UIGraphicsBeginImageContextWithOptions(size, true, 1.0)
          image.draw(in: CGRect(origin: .zero, size: size))
          let scaledImage = UIGraphicsGetImageFromCurrentImageContext()
          UIGraphicsEndImageContext()
          
          guard let scaled = scaledImage, let cgImage = scaled.cgImage else {
            promise.reject("ERR_IMAGE_RESIZE", "Failed to resize image")
            return
          }
          
          // 2. Extract grayscale pixels
          let width = 32
          let height = 32
          var rawBytes = [UInt8](repeating: 0, count: width * height * 4)
          let context = CGContext(
            data: &rawBytes,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          )
          context?.draw(cgImage, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
          
          var greyscale = [[Double]](repeating: [Double](repeating: 0.0, count: 32), count: 32)
          for y in 0..<32 {
            for x in 0..<32 {
              let offset = (y * width + x) * 4
              let r = Double(rawBytes[offset])
              let g = Double(rawBytes[offset + 1])
              let b = Double(rawBytes[offset + 2])
              greyscale[y][x] = (r + g + b) / 3.0
            }
          }
          
          // 3. Compute DCT
          var dct = [[Double]](repeating: [Double](repeating: 0.0, count: 32), count: 32)
          var c = [Double](repeating: 1.0, count: 32)
          c[0] = 1.0 / sqrt(2.0)
          
          let N = 32.0
          let pi = Double.pi
          
          for u in 0..<32 {
            for v in 0..<32 {
              var sum = 0.0
              for i in 0..<32 {
                for j in 0..<32 {
                  sum += cos(((2.0 * Double(i) + 1.0) / (2.0 * N)) * Double(u) * pi) *
                         cos(((2.0 * Double(j) + 1.0) / (2.0 * N)) * Double(v) * pi) *
                         greyscale[i][j]
                }
              }
              sum *= (c[u] * c[v]) / sqrt(2.0 * N)
              dct[u][v] = sum
            }
          }
          
          // 4. Average 8x8 coefficients
          var dctSum = 0.0
          for x in 0..<8 {
            for y in 0..<8 {
              dctSum += dct[x][y]
            }
          }
          dctSum -= dct[0][0]
          let dctAverage = dctSum / 63.0
          
          // 5. Generate 64-bit hash
          var result: UInt64 = 0
          var cnt = 0
          for row in 0..<8 {
            for col in 0..<8 {
              if (row != 0 || col != 0) && dct[row][col] > dctAverage {
                result |= (UInt64(1) << cnt)
              }
              cnt += 1
            }
          }
          
          promise.resolve(String(result))
        } catch {
          promise.reject("ERR_PHASH_FAILED", error.localizedDescription)
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

  /// Filters out non-alphanumeric characters from an identifier.
  private func sanitizeIdentifier(_ identifier: String) -> String {
    return identifier.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
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
