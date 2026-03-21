package expo.modules.lomohasher

import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest

class ExpoLomoHasherModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoLomoHasher")

    AsyncFunction("hashFileAsync") { uriString: String ->
        val digest = MessageDigest.getInstance("SHA-1")
        val uri = Uri.parse(uriString)
        val context = appContext.reactContext ?: throw Exception("React context not available")
        
        val logFile = File(context.filesDir, "hasher_debug.log")
        fun logToFile(msg: String) {
            Log.d("ExpoLomoHasher", msg)
            try {
                logFile.appendText("$msg\n")
            } catch (e: Exception) {
                // Ignore log failures
            }
        }

        val inputStream: InputStream = if (uri.scheme == "content") {
            val requireOriginalUri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    MediaStore.setRequireOriginal(uri)
                } catch (e: Exception) {
                    logToFile("setRequireOriginal failed: ${e.message}")
                    uri
                }
            } else {
                uri
            }
            logToFile("Opening content URI (SDK ${Build.VERSION.SDK_INT}): $requireOriginalUri")
            context.contentResolver.openInputStream(requireOriginalUri)
                ?: throw Exception("Could not open content URI: $uriString")
        } else {
            var path = uriString
            if (path.startsWith("file://")) {
                path = path.substring(7)
            }
            logToFile("Opening file:// path: $path")
            val file = File(path)
            if (!file.exists()) {
                throw Exception("File not found at $path")
            }
            FileInputStream(file)
        }

        val buffer = ByteArray(1024 * 1024) // 1MB for speed
        var totalBytesRead = 0L
        
        // Debug file for the specific problematic size or URI
        val isTargetFile = (uriString.contains("005404073") || uriString.contains("1610379"))
        val debugFile = if (isTargetFile) File(context.filesDir, "debug_dump.bin") else null
        val debugOutputStream = debugFile?.let { FileOutputStream(it) }

        try {
            while (true) {
                val read = inputStream.read(buffer)
                if (read == -1) break

                if (totalBytesRead == 0L && read >= 16) {
                    val firstBytes = (0..15).joinToString("") { String.format("%02x", buffer[it]) }
                    logToFile("START BYTES for $uriString: $firstBytes")
                }
                
                debugOutputStream?.write(buffer, 0, read)

                digest.update(buffer, 0, read)
                totalBytesRead += read
            }
            logToFile("FINISH. Total bytes hashed: $totalBytesRead")
            if (debugFile != null) {
                logToFile("Debug dump written to: ${debugFile.absolutePath}")
            }
        } finally {
            inputStream.close()
            debugOutputStream?.close()
        }
        
        val sha1 = digest.digest()
        val hexChars = CharArray(sha1.size * 2)
        val hexArray = "0123456789abcdef".toCharArray()
        for (j in sha1.indices) {
            val v = sha1[j].toInt() and 0xFF
            hexChars[j * 2] = hexArray[v ushr 4]
            hexChars[j * 2 + 1] = hexArray[v and 0x0F]
        }
        val result = String(hexChars)
        logToFile("RESULT for $uriString: $result")
        result
    }
  }
}
