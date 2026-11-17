package expo.modules.lomohasher

import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
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


internal fun cpuSessionOptions(): OrtSession.SessionOptions {
  return OrtSession.SessionOptions().apply {
    setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
    setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(2, 4))
  }
}

class ExpoLomoHasherModule : Module() {
  private var visualSession: OrtSession? = null
  private var faceSession: OrtSession? = null
  private var textualSession: OrtSession? = null
  private val ortEnv = OrtEnvironment.getEnvironment()
  private var clipTokenizer: ClipTokenizer? = null

  private fun resolveModelPath(modelPath: String): String {
    if (modelPath.contains("/") || modelPath.contains("\\")) {
      // Strip file:// prefix if present — ONNX Runtime requires a raw filesystem path
      return if (modelPath.startsWith("file://")) modelPath.substring(7) else modelPath
    }
    val context = appContext.reactContext ?: throw Exception("React context not available")
    val file = File(context.filesDir, modelPath)
    var inputLength = 0L
    try {
      val fd = context.assets.openFd(modelPath)
      inputLength = fd.length
      fd.close()
    } catch (e: Exception) {
      try {
        context.assets.open(modelPath).use { inputLength = it.available().toLong() }
      } catch (e2: Exception) {
        return modelPath
      }
    }
    if (file.exists() && file.length() == inputLength) {
      return file.absolutePath
    }
    val tmpFile = File(context.filesDir, "$modelPath.tmp")
    try {
      context.assets.open(modelPath).use { input ->
        FileOutputStream(tmpFile).use { output ->
          input.copyTo(output)
        }
      }
      if (tmpFile.renameTo(file)) {
        return file.absolutePath
      }
    } catch (e: Exception) {
      tmpFile.delete()
    }
    return file.absolutePath
  }

  private fun getVisualSession(modelPath: String): OrtSession {
    val current = visualSession
    if (current != null) return current
    val resolved = resolveModelPath(modelPath)
    val session = ortEnv.createSession(resolved, cpuSessionOptions())
    visualSession = session
    return session
  }

  private fun getFaceSession(modelPath: String): OrtSession {
    val current = faceSession
    if (current != null) return current
    val resolved = resolveModelPath(modelPath)
    val session = ortEnv.createSession(resolved, cpuSessionOptions())
    faceSession = session
    return session
  }

  private fun getTextualSession(modelPath: String): OrtSession {
    val current = textualSession
    if (current != null) return current
    val resolved = resolveModelPath(modelPath)
    val session = ortEnv.createSession(resolved, cpuSessionOptions())
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
    val bitmapCropped = Bitmap.createBitmap(bitmap, cropX, cropY, cropSize, cropSize)
    val scaled = Bitmap.createScaledBitmap(bitmapCropped, imageSize, imageSize, true)
    if (bitmapCropped != bitmap && bitmapCropped != scaled) {
      bitmapCropped.recycle()
    }
    return scaled
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
        
        fun logToFile(msg: String) {
            Log.d("ExpoLomoHasher", msg)
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

        try {
            while (true) {
                val read = inputStream.read(buffer)
                if (read == -1) break

                if (totalBytesRead == 0L && read >= 16) {
                    val firstBytes = (0..15).joinToString("") { String.format("%02x", buffer[it]) }
                    logToFile("START BYTES for $uriString: $firstBytes")
                }

                digest.update(buffer, 0, read)
                totalBytesRead += read
            }
            logToFile("FINISH. Total bytes hashed: $totalBytesRead")
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
                    if (read <= 0) break
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

    // Copies length bytes of sourceUri starting at offset into destUri (fewer at end of file),
    // for uploading a large file in pieces a size-limited proxy will accept.
    AsyncFunction("sliceFileRangeAsync") { sourceUriString: String, destUriString: String, offset: Long, length: Long ->
        if (offset < 0 || length <= 0) {
            throw Exception("Invalid range offset=$offset length=$length")
        }
        val sourceUri = Uri.parse(sourceUriString)
        val context = appContext.reactContext ?: throw Exception("React context not available")

        // Seek through a file descriptor where we can: a large file is sliced into many pieces,
        // and skip() on some content providers reads through every byte before the offset.
        var seeked = false
        val inputStream: InputStream = if (sourceUri.scheme == "content") {
            val pfd = try { context.contentResolver.openFileDescriptor(sourceUri, "r") } catch (e: Exception) { null }
            if (pfd != null) {
                val fis = ParcelFileDescriptor.AutoCloseInputStream(pfd)
                try {
                    fis.channel.position(offset)
                    seeked = true
                } catch (e: Exception) {
                    // not seekable (e.g. a pipe); fall back to skipping below
                }
                fis
            } else {
                context.contentResolver.openInputStream(sourceUri)
                    ?: throw Exception("Could not open content URI: $sourceUriString")
            }
        } else {
            val file = File(sourceUriString.removePrefix("file://"))
            if (!file.exists()) {
                throw Exception("Source file not found at ${file.path}")
            }
            FileInputStream(file).also {
                it.channel.position(offset)
                seeked = true
            }
        }

        val destFile = File(destUriString.removePrefix("file://"))
        destFile.parentFile?.mkdirs()
        val outputStream = FileOutputStream(destFile)

        try {
            var skipped = if (seeked) offset else 0L
            while (skipped < offset) {
                val n = inputStream.skip(offset - skipped)
                if (n > 0) {
                    skipped += n
                    continue
                }
                // skip() may return 0 on some content streams; fall back to reading
                val tmp = ByteArray(Math.min(8192L, offset - skipped).toInt())
                val read = inputStream.read(tmp)
                if (read <= 0) throw Exception("Offset $offset is beyond end of file")
                skipped += read
            }
            val buffer = ByteArray(1024 * 1024)
            var remaining = length
            var written = 0L
            while (remaining > 0) {
                val read = inputStream.read(buffer, 0, Math.min(buffer.size.toLong(), remaining).toInt())
                if (read == -1) break
                outputStream.write(buffer, 0, read)
                remaining -= read
                written += read
            }
            written
        } finally {
            try { inputStream.close() } catch (e: Exception) {}
            try { outputStream.close() } catch (e: Exception) {}
        }
    }

    AsyncFunction("encodeImageEmbeddingAsync") { imageUriString: String, modelPath: String ->
      val uri = Uri.parse(imageUriString)
      val context = appContext.reactContext ?: throw Exception("React context not available")

      // ~320px on the short side. decodeToward keeps this sample loop and
      // decodes through a seekable descriptor, so a camera original is not
      // allocated at full size.
      var bitmap = decodeToward(context, uri, 320)
      val rotation = readOrientationDegrees(context, uri)
      bitmap = rotateByDegrees(bitmap, rotation)

      val session = getVisualSession(modelPath)
      var cropped: Bitmap? = null
      var inputTensor: OnnxTensor? = null
      
      try {
          cropped = centerCrop(bitmap, 224)
          val processed = preProcess(cropped)
          
          val inputShape = longArrayOf(1, 3, 224, 224)
          inputTensor = OnnxTensor.createTensor(ortEnv, processed, inputShape)
          
          val outputs = session.run(java.util.Collections.singletonMap("pixel_values", inputTensor))
          val embedding = outputs.use {
            val raw = ((outputs.get(0).value) as Array<FloatArray>)[0]
            normalizeL2(raw)
          }
          floatArrayToBase64(embedding)
      } finally {
          inputTensor?.close()
          cropped?.recycle()
          bitmap.recycle()
      }
    }

    AsyncFunction("encodeTextEmbeddingAsync") { text: String, modelPath: String, vocabPath: String, mergesPath: String ->
      val tokenizer = getTokenizer(vocabPath, mergesPath)
      val session = getTextualSession(modelPath)
      
      val tokenBOS = 49406
      val tokenEOS = 49407

      val queryFilter = Regex("[^A-Za-z0-9' ]")
      val textClean = queryFilter.replace(text, "").lowercase()
      
      val tokens = mutableListOf<Int>()
      tokens.add(tokenBOS)
      val bodyTokens = tokenizer.encode(textClean).take(75)
      tokens.addAll(bodyTokens)
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
      
      var inputIdsTensor: OnnxTensor? = null
      var attentionMaskTensor: OnnxTensor? = null
      
      try {
          inputIdsTensor = OnnxTensor.createTensor(ortEnv, inputIds, inputShape)
          attentionMaskTensor = OnnxTensor.createTensor(ortEnv, attentionMask, inputShape)
          
          val inputMap = hashMapOf<String, OnnxTensor>()
          inputMap["input_ids"] = inputIdsTensor
          inputMap["attention_mask"] = attentionMaskTensor
          
          val outputs = session.run(inputMap)
          val embedding = outputs.use {
            val raw = ((outputs.get(0).value) as Array<FloatArray>)[0]
            normalizeL2(raw)
          }
          floatArrayToBase64(embedding)
      } finally {
          inputIdsTensor?.close()
          attentionMaskTensor?.close()
      }
    }

    // Oriented JPEG whose long edge is at most ANALYSIS_MAX_EDGE, plus the scale
    // that maps original-image coordinates onto it. scale is 1 and uri is the
    // input when the file is already small and upright. ML Kit must be given
    // this uri: it decodes the file itself, so handing it the camera original
    // crashes the same way a full-size embed did.
    AsyncFunction("prepareAnalysisImageAsync") { imageUriString: String ->
      val uri = Uri.parse(imageUriString)
      val context = appContext.reactContext ?: throw Exception("React context not available")
      val rotation = readOrientationDegrees(context, uri)
      val bounds = readImageBounds(context, uri)
      val rawW = bounds.outWidth
      val rawH = bounds.outHeight
      if (rawW <= 0 || rawH <= 0) throw Exception("Could not read image size: $imageUriString")
      if (rotation == 0 && rawW <= ANALYSIS_MAX_EDGE && rawH <= ANALYSIS_MAX_EDGE) {
        mapOf(
          "uri" to imageUriString,
          "width" to rawW,
          "height" to rawH,
          "scale" to 1.0
        )
      } else {
        val decoded = decodeAnalysisBitmap(context, uri)
        try {
          val out = File(context.cacheDir, "analysis-${System.nanoTime()}.jpg")
          FileOutputStream(out).use { stream ->
            if (!decoded.bitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)) {
              throw Exception("Could not write downscaled image")
            }
          }
          mapOf(
            "uri" to Uri.fromFile(out).toString(),
            "width" to decoded.bitmap.width,
            "height" to decoded.bitmap.height,
            "scale" to decoded.scaleX.toDouble()
          )
        } finally {
          decoded.bitmap.recycle()
        }
      }
    }

    AsyncFunction("encodeFaceEmbeddingAsync") { imageUriString: String, boundingBox: Map<String, Any>, modelPath: String ->
      val uri = Uri.parse(imageUriString)
      val context = appContext.reactContext ?: throw Exception("React context not available")

      // Never the full camera frame. Boxes from a detector that saw the original
      // are scaled onto this bitmap; boxes from prepareAnalysisImageAsync are
      // already in this space and the scale comes out as 1.
      val decoded = decodeAnalysisBitmap(context, uri)
      val bitmap = decoded.bitmap
      val scaleX = decoded.scaleX
      val scaleY = decoded.scaleY

      var croppedBitmap: Bitmap? = null
      var scaledCrop: Bitmap? = null
      var inputTensor: OnnxTensor? = null
      
      try {
          // Step 2: Extract bounding box and crop
          var x = (((boundingBox["x"] as? Number)?.toFloat() ?: 0f) * scaleX).toInt()
          var y = (((boundingBox["y"] as? Number)?.toFloat() ?: 0f) * scaleY).toInt()
          var w = if (boundingBox["width"] is Number) ((boundingBox["width"] as Number).toFloat() * scaleX).toInt() else bitmap.width
          var h = if (boundingBox["height"] is Number) ((boundingBox["height"] as Number).toFloat() * scaleY).toInt() else bitmap.height

          // Ensure bounding box is within bitmap dimensions
          x = Math.max(0, x)
          y = Math.max(0, y)
          if (x + w > bitmap.width) w = bitmap.width - x
          if (y + h > bitmap.height) h = bitmap.height - y

          if (w <= 0 || h <= 0) {
              throw Exception("Invalid bounding box dimensions: w=$w, h=$h")
          }

          val leftEye = boundingBox["leftEye"] as? Map<*, *>
          val rightEye = boundingBox["rightEye"] as? Map<*, *>

          if (leftEye != null && rightEye != null) {
              val lx = ((leftEye["x"] as? Number)?.toFloat() ?: 0f) * scaleX
              val ly = ((leftEye["y"] as? Number)?.toFloat() ?: 0f) * scaleY
              val rx = ((rightEye["x"] as? Number)?.toFloat() ?: 0f) * scaleX
              val ry = ((rightEye["y"] as? Number)?.toFloat() ?: 0f) * scaleY
              
              val src = floatArrayOf(lx, ly, rx, ry)
              // ArcFace 112x112 standard eye coordinates
              val dst = floatArrayOf(
                  38.2946f, 51.6963f,
                  73.5318f, 51.5014f
              )
              
              val matrix = android.graphics.Matrix()
              matrix.setPolyToPoly(src, 0, dst, 0, 2)
              
              scaledCrop = Bitmap.createBitmap(112, 112, Bitmap.Config.ARGB_8888)
              val canvas = android.graphics.Canvas(scaledCrop)
              val paint = android.graphics.Paint()
              paint.isAntiAlias = true
              paint.isFilterBitmap = true
              canvas.drawBitmap(bitmap, matrix, paint)
          } else {
              croppedBitmap = Bitmap.createBitmap(bitmap, x, y, w, h)
              scaledCrop = Bitmap.createScaledBitmap(croppedBitmap, 112, 112, true)
          }
          
          // Step 3: Preprocess (112x112, normalized (val - 127.5)/128.0)
          val stride = 112 * 112
          val imgData = FloatBuffer.allocate(1 * 3 * stride)
          imgData.rewind()
          val bmpData = IntArray(stride)
          scaledCrop.getPixels(bmpData, 0, 112, 0, 0, 112, 112)
          
          for (i in 0 until 112) {
              for (j in 0 until 112) {
                  val idx = 112 * i + j
                  val pixelValue = bmpData[idx]
                  // SFace / MobileFaceNet typical normalization: (val - 127.5) / 128.0
                  // Extract RGB (Bitmap is ARGB_8888)
                  val r = (pixelValue shr 16 and 0xFF).toFloat()
                  val g = (pixelValue shr 8 and 0xFF).toFloat()
                  val b = (pixelValue and 0xFF).toFloat()
                  
                  // InsightFace models (like w600k_r50.onnx and MobileFaceNet) expect BGR input channel order
                  imgData.put(idx, (b - 127.5f) / 128.0f)              // Channel 0: Blue
                  imgData.put(idx + stride, (g - 127.5f) / 128.0f)     // Channel 1: Green
                  imgData.put(idx + stride * 2, (r - 127.5f) / 128.0f) // Channel 2: Red
              }
          }
          imgData.rewind()

          val session = getFaceSession(modelPath)
          val inputShape = longArrayOf(1, 3, 112, 112)
          inputTensor = OnnxTensor.createTensor(ortEnv, imgData, inputShape)
          
          // We pass the tensor to the session. 
          // SFace input name is typically "input" or "data".
          val inputName = session.inputNames.iterator().next()
          val outputs = session.run(java.util.Collections.singletonMap(inputName, inputTensor))
          val embedding = outputs.use {
            val raw = ((outputs.get(0).value) as Array<FloatArray>)[0]
            normalizeL2(raw)
          }
          // Encode cropped bitmap to Base64 for CoverImage
          val outStream = java.io.ByteArrayOutputStream()
          scaledCrop.compress(Bitmap.CompressFormat.JPEG, 90, outStream)
          val croppedBase64 = android.util.Base64.encodeToString(outStream.toByteArray(), android.util.Base64.NO_WRAP)
          
          val result = mapOf(
              "embedding" to floatArrayToBase64(embedding),
              "croppedImage" to croppedBase64
          )
          
          result
      } finally {
          inputTensor?.close()
          scaledCrop?.recycle()
          croppedBitmap?.recycle()
          bitmap.recycle()
      }
    }

    AsyncFunction("generatePHashAsync") { imageUriString: String ->
      val uri = Uri.parse(imageUriString)
      val context = appContext.reactContext ?: throw Exception("React context not available")

      val bitmap = decodeToward(context, uri, 128)

      // Step 2: Resize to 32x32
      val scaled = Bitmap.createScaledBitmap(bitmap, 32, 32, true)
      bitmap.recycle()
      
      // Step 3: Grayscale
      val greyscale = Array(32) { DoubleArray(32) }
      for (y in 0 until 32) {
          for (x in 0 until 32) {
              val pixel = scaled.getPixel(x, y)
              val r = (pixel shr 16) and 0xff
              val g = (pixel shr 8) and 0xff
              val b = pixel and 0xff
              greyscale[y][x] = (r + g + b) / 3.0
          }
      }
      scaled.recycle()
      
      // Step 4: Compute DCT
      val dct = Array(32) { DoubleArray(32) }
      val N = 32
      val c = DoubleArray(32) { 1.0 }
      c[0] = 1.0 / Math.sqrt(2.0)
      
      for (u in 0 until 32) {
          for (v in 0 until 32) {
              var sum = 0.0
              for (i in 0 until 32) {
                  for (j in 0 until 32) {
                      sum += Math.cos(((2 * i + 1.0) / (2.0 * N)) * u * Math.PI) * 
                             Math.cos(((2 * j + 1.0) / (2.0 * N)) * v * Math.PI) * 
                             greyscale[i][j]
                  }
              }
              sum *= (c[u] * c[v]) / Math.sqrt(2.0 * N)
              dct[u][v] = sum
          }
      }
      
      // Step 5: Calculate Average of 8x8 DCT (excluding first element)
      var dctSum = 0.0
      for (x in 0 until 8) {
          for (y in 0 until 8) {
              dctSum += dct[x][y]
          }
      }
      dctSum -= dct[0][0]
      val dctAverage = dctSum / 63.0
      
      // Step 6: Generate 64-bit hash
      var result: Long = 0
      var cnt = 0
      for (row in 0 until 8) {
          for (col in 0 until 8) {
              if ((row != 0 || col != 0) && dct[row][col] > dctAverage) {
                  result = result or (1L shl cnt)
              }
              cnt++
          }
      }
      
      java.lang.Long.toUnsignedString(result)
    }
  }
}
