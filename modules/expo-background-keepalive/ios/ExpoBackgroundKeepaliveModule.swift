import ExpoModulesCore
import AVFoundation

public class ExpoBackgroundKeepaliveModule: Module {
  var audioPlayer: AVAudioPlayer?

  public func definition() -> ModuleDefinition {
    Name("ExpoBackgroundKeepalive")

    Function("start") {
      self.startSilentAudio()
    }

    Function("stop") {
      self.stopSilentAudio()
    }
  }

  private func startSilentAudio() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
    } catch {
      print("ExpoBackgroundKeepalive: Failed to set audio session category.")
    }

    if audioPlayer == nil {
      // A base64 string of a very short, silent WAV file.
      // This prevents the need to bundle an actual asset file.
      let silentWavBase64 = "UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA=="
      if let data = Data(base64Encoded: silentWavBase64) {
        do {
          audioPlayer = try AVAudioPlayer(data: data)
          audioPlayer?.numberOfLoops = -1 // Loop indefinitely
          audioPlayer?.volume = 0.0 // Ensure it's silent
        } catch {
          print("ExpoBackgroundKeepalive: Failed to initialize AVAudioPlayer.")
        }
      }
    }
    
    audioPlayer?.play()
    print("ExpoBackgroundKeepalive: Started playing silent audio.")
  }

  private func stopSilentAudio() {
    audioPlayer?.stop()
    do {
      try AVAudioSession.sharedInstance().setActive(false)
      print("ExpoBackgroundKeepalive: Stopped playing silent audio.")
    } catch {
      print("ExpoBackgroundKeepalive: Failed to deactivate audio session.")
    }
  }
}
