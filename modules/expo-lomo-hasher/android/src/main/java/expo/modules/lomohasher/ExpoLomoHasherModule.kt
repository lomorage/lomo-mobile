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
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import java.nio.FloatBuffer
import java.nio.IntBuffer

class ExpoLomoHasherModule : Module() {
  private var visualSession: OrtSession? = null
  private var textualSession: OrtSession? = null
  private val ortEnv = OrtEnvironment.getEnvironment()
  private var clipTokenizer: ClipTokenizer? = null

  private fun resolveModelPath(modelPath: String): String {
    if (modelPath.contains("/") || modelPath.contains("\\")) {
      return modelPath
    }
    val context = appContext.reactContext ?: throw Exception("React context not available")
    val file = File(context.filesDir, modelPath)
    var inputLength = 0L
    try {
      context.assets.open(modelPath).use { inputLength = it.available().toLong() }
    } catch (e: Exception) {
      return modelPath
    }
    if (file.exists() && file.length() == inputLength) {
      return file.absolutePath
    }
    context.assets.open(modelPath).use { input ->
      FileOutputStream(file).use { output ->
        input.copyTo(output)
      }
    }
    return file.absolutePath
  }

  private fun getVisualSession(modelPath: String): OrtSession {
    val current = visualSession
    if (current != null) return current
    val resolved = resolveModelPath(modelPath)
    val options = OrtSession.SessionOptions().apply {
      setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(2, 4))
    }
    val session = ortEnv.createSession(resolved, options)
    visualSession = session
    return session
  }

  private fun getTextualSession(modelPath: String): OrtSession {
    val current = textualSession
    if (current != null) return current
    val resolved = resolveModelPath(modelPath)
    val options = OrtSession.SessionOptions().apply {
      setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(2, 4))
    }
    val session = ortEnv.createSession(resolved, options)
    textualSession = session
    return session
  }

  private fun getTokenizer(vocabPath: String, mergesPath: String): ClipTokenizer {
    val current = clipTokenizer
    if (current != null) return current
    val resolvedVocab = resolveModelPath(vocabPath)
    val resolvedMerges = resolveModelPath(mergesPath)
    val tokenizer = ClipTokenizer(File(resolvedVocab), File(resolvedMerges))
    clipTokenizer = tokenizer
    return tokenizer
  }

  private fun centerCrop(bitmap: Bitmap, imageSize: Int): Bitmap {
    val cropX: Int
    val cropY: Int
    val cropSize: Int
    if (bitmap.width >= bitmap.height) {
        cropX = bitmap.width / 2 - bitmap.height / 2
        cropY = 0
        cropSize = bitmap.height
    } else {
        cropX = 0
        cropY = bitmap.height / 2 - bitmap.width / 2
        cropSize = bitmap.width
    }
    val bitmapCropped = Bitmap.createBitmap(
        bitmap, cropX, cropY, cropSize, cropSize
    )
    return Bitmap.createScaledBitmap(bitmapCropped, imageSize, imageSize, false)
  }

  private fun preProcess(bitmap: Bitmap): FloatBuffer {
    val stride = 224 * 224
    val imgData = FloatBuffer.allocate(1 * 3 * stride)
    imgData.rewind()
    val bmpData = IntArray(stride)
    bitmap.getPixels(bmpData, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    for (i in 0 until 224) {
        for (j in 0 until 224) {
            val idx = 224 * i + j
            val pixelValue = bmpData[idx]
            imgData.put(idx, (((pixelValue shr 16 and 0xFF) / 255f - 0.48145467f) / 0.26862955f))
            imgData.put(
                idx + stride, (((pixelValue shr 8 and 0xFF) / 255f - 0.4578275f) / 0.2613026f)
            )
            imgData.put(
                idx + stride * 2, (((pixelValue and 0xFF) / 255f - 0.40821072f) / 0.2757771f)
            )
        }
    }
    imgData.rewind()
    return imgData
  }

  private fun normalizeL2(inputArray: FloatArray): FloatArray {
    var norm = 0.0f
    for (i in inputArray.indices) {
        norm += inputArray[i] * inputArray[i]
    }
    norm = kotlin.math.sqrt(norm)
    if (norm == 0.0f) return inputArray
    return inputArray.map { it / norm }.toFloatArray()
  }

  private fun floatArrayToBase64(floats: FloatArray): String {
    val byteBuffer = java.nio.ByteBuffer.allocate(floats.size * 4)
    byteBuffer.order(java.nio.ByteOrder.LITTLE_ENDIAN)
    for (f in floats) {
      byteBuffer.putFloat(f)
    }
    return Base64.encodeToString(byteBuffer.array(), Base64.NO_WRAP)
  }
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
        var buffer: ByteArray
        try {
            buffer = ByteArray(1024 * 1024) // 1MB for max speed
        } catch (e: OutOfMemoryError) {
            buffer = ByteArray(128 * 1024) // 128KB fallback for fragmented heaps
        }
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

    AsyncFunction("sliceFileAsync") { sourceUriString: String, destUriString: String, offset: Long ->
        val sourceUri = Uri.parse(sourceUriString)
        val context = appContext.reactContext ?: throw Exception("React context not available")

        val inputStream: InputStream = if (sourceUri.scheme == "content") {
            context.contentResolver.openInputStream(sourceUri)
                ?: throw Exception("Could not open content URI: $sourceUriString")
        } else {
            var path = sourceUriString
            if (path.startsWith("file://")) {
                path = path.substring(7)
            }
            val file = File(path)
            if (!file.exists()) {
                throw Exception("Source file not found at $path")
            }
            FileInputStream(file)
        }

        var destPath = destUriString
        if (destPath.startsWith("file://")) {
            destPath = destPath.substring(7)
        }
        val destFile = File(destPath)
        destFile.parentFile?.mkdirs()
        val outputStream = FileOutputStream(destFile)

        try {
            var skipped = 0L
            while (skipped < offset) {
                val skipAttempt = inputStream.skip(offset - skipped)
                if (skipAttempt <= 0) {
                    val tempBuffer = ByteArray(Math.min(8192L, offset - skipped).toInt())
                    val read = inputStream.read(tempBuffer)
                    if (read == -1) break
                    skipped += read
                } else {
                    skipped += skipAttempt
                }
            }
            var buffer: ByteArray
            try {
                buffer = ByteArray(1024 * 1024)
            } catch (e: OutOfMemoryError) {
                buffer = ByteArray(128 * 1024)
            }
            while (true) {
                val read = inputStream.read(buffer)
                if (read == -1) break
                outputStream.write(buffer, 0, read)
            }
            true
        } finally {
            try {
                inputStream.close()
            } catch (e: Exception) {}
            try {
                outputStream.close()
            } catch (e: Exception) {}
        }
    }

    AsyncFunction("encodeImageEmbeddingAsync") { imageUriString: String, modelPath: String ->
      val uri = Uri.parse(imageUriString)
      val context = appContext.reactContext ?: throw Exception("React context not available")
      val inputStream = context.contentResolver.openInputStream(uri)
          ?: throw Exception("Could not open input stream for: $imageUriString")
      val bitmap = BitmapFactory.decodeStream(inputStream)
      inputStream.close()
      
      if (bitmap == null) {
          throw Exception("Could not decode bitmap for: $imageUriString")
      }

      val session = getVisualSession(modelPath)
      val cropped = centerCrop(bitmap, 224)
      val processed = preProcess(cropped)
      
      val inputShape = longArrayOf(1, 3, 224, 224)
      val inputTensor = OnnxTensor.createTensor(ortEnv, processed, inputShape)
      
      val outputs = session.run(java.util.Collections.singletonMap("pixel_values", inputTensor))
      val embedding = outputs.use {
        val raw = ((outputs.get(0).value) as Array<FloatArray>)[0]
        normalizeL2(raw)
      }
      inputTensor.close()
      cropped.recycle()
      bitmap.recycle()
      
      floatArrayToBase64(embedding)
    }

    AsyncFunction("encodeTextEmbeddingAsync") { text: String, modelPath: String, vocabPath: String, mergesPath: String ->
      val tokenizer = getTokenizer(vocabPath, mergesPath)
      val session = getTextualSession(modelPath)
      
      val tokenBOS = 49406
      val tokenEOS = 49407

      val queryFilter = Regex("[^A-Za-z0-9 ]")
      val textClean = queryFilter.replace(text, "").lowercase()
      
      val tokens = mutableListOf<Int>()
      tokens.add(tokenBOS)
      tokens.addAll(tokenizer.encode(textClean))
      tokens.add(tokenEOS)

      val mask = mutableListOf<Int>()
      for (i in tokens.indices) {
          mask.add(1)
      }
      while (tokens.size < 77) {
          tokens.add(0)
          mask.add(0)
      }
      
      val tokensFinal = tokens.subList(0, 77)
      val maskFinal = mask.subList(0, 77)

      val inputShape = longArrayOf(1, 77)
      val inputIds = IntBuffer.allocate(77)
      val attentionMask = IntBuffer.allocate(77)
      
      for (i in 0 until 77) {
          inputIds.put(tokensFinal[i])
          attentionMask.put(maskFinal[i])
      }
      inputIds.rewind()
      attentionMask.rewind()
      
      val inputIdsTensor = OnnxTensor.createTensor(ortEnv, inputIds, inputShape)
      val attentionMaskTensor = OnnxTensor.createTensor(ortEnv, attentionMask, inputShape)
      
      val inputMap = hashMapOf<String, OnnxTensor>()
      inputMap["input_ids"] = inputIdsTensor
      inputMap["attention_mask"] = attentionMaskTensor
      
      val outputs = session.run(inputMap)
      val embedding = outputs.use {
        val raw = ((outputs.get(0).value) as Array<FloatArray>)[0]
        normalizeL2(raw)
      }
      
      inputIdsTensor.close()
      attentionMaskTensor.close()
      
      floatArrayToBase64(embedding)
    }
  }
}
