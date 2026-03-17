import ExpoModulesCore
import CryptoKit
import Foundation

public class ExpoLomoHasherModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoLomoHasher")

    AsyncFunction("hashFileAsync") { (uriString: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          guard let url = URL(string: uriString) else {
            promise.reject("INVALID_URI", "Invalid URI string")
            return
          }
          
          let fileHandle = try FileHandle(forReadingFrom: url)
          defer {
            try? fileHandle.close()
          }
          
          var hasher = Insecure.SHA1()
          let bufferSize = 1024 * 1024 // 1MB chunk to keep memory footprint flat
          
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
}
