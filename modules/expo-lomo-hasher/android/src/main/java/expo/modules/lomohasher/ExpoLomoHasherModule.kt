package expo.modules.lomohasher

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest

class ExpoLomoHasherModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoLomoHasher")

    AsyncFunction("hashFileAsync") { uriString: String ->
        val digest = MessageDigest.getInstance("SHA-1")
        val uri = Uri.parse(uriString)
        
        val inputStream: InputStream = if (uri.scheme == "content") {
            appContext.reactContext?.contentResolver?.openInputStream(uri)
                ?: throw Exception("Could not open content URI: $uriString")
        } else {
            var path = uriString
            if (path.startsWith("file://")) {
                path = path.substring(7)
            }
            val file = File(path)
            if (!file.exists()) {
                throw Exception("File not found at $path")
            }
            FileInputStream(file)
        }

        val buffer = ByteArray(1024 * 1024) // 1MB chunk to be extremely fast
        
        try {
            while (true) {
                val read = inputStream.read(buffer)
                if (read == -1) break
                digest.update(buffer, 0, read)
            }
        } finally {
            inputStream.close()
        }
        
        val sha1 = digest.digest()
        val hexChars = CharArray(sha1.size * 2)
        val hexArray = "0123456789abcdef".toCharArray()
        for (j in sha1.indices) {
            val v = sha1[j].toInt() and 0xFF
            hexChars[j * 2] = hexArray[v ushr 4]
            hexChars[j * 2 + 1] = hexArray[v and 0x0F]
        }
        String(hexChars)
    }
  }
}
