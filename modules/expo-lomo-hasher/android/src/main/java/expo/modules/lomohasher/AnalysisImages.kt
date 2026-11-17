package expo.modules.lomohasher

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream

// ML Kit's InputImage.fromFilePath decodes the whole file. A 50MP camera frame
// is about 200MB, and anything that then copies it (EXIF rotate, a second
// decoder) kills the process. The per-app limit does not grow with the phone's
// RAM, which is why the same crash showed up on an S23+ and on a 24GB emulator.
//
// Decode through a seekable file. BitmapFactory.decodeFileDescriptor only
// honors inSampleSize when the descriptor itself can seek; a MediaStore
// content:// uri is often a pipe, and the decoder then allocates the full
// camera frame. When the descriptor cannot seek, the compressed file is
// copied to cache first. That copy is the JPEG, not the pixels.
internal const val ANALYSIS_MAX_EDGE = 2048

internal class AnalysisBitmap(val bitmap: Bitmap, val scaleX: Float, val scaleY: Float)

internal fun readOrientationDegrees(context: Context, uri: Uri): Int {
  try {
    context.contentResolver.openInputStream(uri)?.use { stream ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return 0
      val exif = ExifInterface(stream)
      val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      return when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        else -> 0
      }
    }
  } catch (e: Exception) {
    Log.e("ExpoLomoHasher", "Error reading exif orientation", e)
  }
  return 0
}

internal fun rotateByDegrees(bitmap: Bitmap, degrees: Int): Bitmap {
  if (degrees == 0) return bitmap
  val matrix = Matrix()
  matrix.postRotate(degrees.toFloat())
  val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
  bitmap.recycle()
  return rotated
}

// scaleX/scaleY map a box in the original oriented image onto this bitmap.
// The 80px floor is scaled by the same factor in minFaceSizeForScale.
internal fun readImageBounds(context: Context, uri: Uri): BitmapFactory.Options {
  val bounds = BitmapFactory.Options().apply {
    inJustDecodeBounds = true
    inScaled = false
  }
  decodeInto(context, uri, bounds)
  return bounds
}

internal fun decodeAnalysisBitmap(context: Context, uri: Uri): AnalysisBitmap {
  val bounds = readImageBounds(context, uri)
  if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
    throw Exception("Could not read image size: $uri")
  }
  val rawW = bounds.outWidth
  val rawH = bounds.outHeight
  val rotation = readOrientationDegrees(context, uri)
  val orientedW = if (rotation == 90 || rotation == 270) rawH else rawW
  val orientedH = if (rotation == 90 || rotation == 270) rawW else rawH

  var sample = 1
  while (rawW / sample > ANALYSIS_MAX_EDGE || rawH / sample > ANALYSIS_MAX_EDGE) {
    if (sample >= 64) break
    sample *= 2
  }

  val opts = BitmapFactory.Options().apply {
    inSampleSize = sample
    inPreferredConfig = Bitmap.Config.ARGB_8888
    inScaled = false
  }
  var bitmap = decodeInto(context, uri, opts)
    ?: throw Exception("Could not decode bitmap: $uri")

  val longEdge = maxOf(bitmap.width, bitmap.height)
  if (longEdge > ANALYSIS_MAX_EDGE) {
    val fit = ANALYSIS_MAX_EDGE.toFloat() / longEdge
    val fitted = Bitmap.createScaledBitmap(
      bitmap,
      (bitmap.width * fit).toInt().coerceAtLeast(1),
      (bitmap.height * fit).toInt().coerceAtLeast(1),
      true
    )
    if (fitted != bitmap) bitmap.recycle()
    bitmap = fitted
  }

  bitmap = rotateByDegrees(bitmap, rotation)
  val scaleX = if (orientedW > 0) bitmap.width.toFloat() / orientedW else 1f
  val scaleY = if (orientedH > 0) bitmap.height.toFloat() / orientedH else 1f
  if (sample > 1 || rotation != 0) {
    Log.i(
      "ExpoLomoHasher",
      "analysis ${bitmap.width}x${bitmap.height} from ${orientedW}x${orientedH} sample=$sample rotation=$rotation"
    )
  }
  return AnalysisBitmap(bitmap, scaleX, scaleY)
}

// CLIP and the duplicate hash pick an inSampleSize, then decode. The sample
// loop is unchanged so a seekable file still lands on the same pixels. The
// decode itself has to use a file descriptor: decodeStream ignores
// inSampleSize on a MediaStore content:// stream, and the full camera frame
// is allocated before face detection ever starts.
internal fun decodeToward(context: Context, uri: Uri, targetSize: Int): Bitmap {
  val bounds = readImageBounds(context, uri)
  val width = bounds.outWidth
  val height = bounds.outHeight
  if (width <= 0 || height <= 0) {
    throw Exception("Could not read image size: $uri")
  }
  var inSampleSize = 1
  if (width > targetSize || height > targetSize) {
    val halfWidth = width / 2
    val halfHeight = height / 2
    while (halfWidth / inSampleSize >= targetSize && halfHeight / inSampleSize >= targetSize) {
      inSampleSize *= 2
    }
  }
  val opts = BitmapFactory.Options()
  // Not inside apply: `inSampleSize = inSampleSize` would write the field
  // to itself and the decoder would see 0, which means the full frame.
  opts.inSampleSize = inSampleSize
  opts.inPreferredConfig = Bitmap.Config.ARGB_8888
  opts.inScaled = false
  val bitmap = decodeInto(context, uri, opts)
    ?: throw Exception("Could not decode bitmap: $uri")
  val decodedLong = maxOf(bitmap.width, bitmap.height)
  val expectedLong = maxOf(width, height) / inSampleSize
  if (decodedLong > expectedLong * 2 + 8) {
    val decodedW = bitmap.width
    val decodedH = bitmap.height
    bitmap.recycle()
    throw Exception("subsample missed: ${decodedW}x${decodedH} from ${width}x${height} sample=$inSampleSize target=$targetSize")
  }
  if (inSampleSize > 1) {
    Log.i(
      "ExpoLomoHasher",
      "sampled ${bitmap.width}x${bitmap.height} from ${width}x${height} sample=$inSampleSize target=$targetSize"
    )
  }
  return bitmap
}

private fun openDescriptor(context: Context, uri: Uri): ParcelFileDescriptor? {
  return try {
    context.contentResolver.openFileDescriptor(uri, "r")
  } catch (e: Exception) {
    null
  }
}

// Returns the decoded bitmap, or null when only the bounds were requested.
internal fun decodeInto(context: Context, uri: Uri, opts: BitmapFactory.Options): Bitmap? {
  // decodeFileDescriptor only honors inSampleSize on a seekable descriptor.
  // A MediaStore content:// handle is often a pipe, so copy the compressed
  // bytes and decode that file. The copy is not the pixels.
  if (!opts.inJustDecodeBounds && opts.inSampleSize > 1) {
    return decodeSubsampledFile(context, uri, opts)
  }
  openDescriptor(context, uri)?.use { pfd ->
    if (isSeekable(pfd.fileDescriptor)) {
      val decoded = decodeDescriptor(pfd.fileDescriptor, opts)
      if (opts.inJustDecodeBounds) {
        if (opts.outWidth > 0 && opts.outHeight > 0) return null
      } else if (decoded != null) {
        return decoded
      }
    }
  }
  context.contentResolver.openInputStream(uri)?.use { stream ->
    return BitmapFactory.decodeStream(stream, null, opts)
  }
  return null
}

private fun decodeSubsampledFile(context: Context, uri: Uri, opts: BitmapFactory.Options): Bitmap? {
  // file:// is already a real file. content:// is copied first because a
  // pipe ignores inSampleSize and would decode the full frame.
  val owned = if (uri.scheme == "file") null else copyToCache(context, uri)
  val path = owned?.absolutePath ?: uri.path ?: return null
  try {
    return BitmapFactory.decodeFile(path, opts)
  } finally {
    owned?.delete()
  }
}

private fun isSeekable(fd: FileDescriptor): Boolean {
  return try {
    Os.lseek(fd, 0, OsConstants.SEEK_CUR)
    true
  } catch (e: ErrnoException) {
    false
  }
}

private fun copyToCache(context: Context, uri: Uri): File? {
  val out = File(context.cacheDir, "decode-${System.nanoTime()}.img")
  return try {
    val input = context.contentResolver.openInputStream(uri) ?: run {
      out.delete()
      return null
    }
    input.use { stream ->
      FileOutputStream(out).use { dest -> stream.copyTo(dest, 1024 * 1024) }
    }
    out
  } catch (e: Exception) {
    out.delete()
    Log.e("ExpoLomoHasher", "Could not copy image for subsampled decode", e)
    null
  }
}

private fun decodeDescriptor(fd: FileDescriptor, opts: BitmapFactory.Options): Bitmap? {
  return BitmapFactory.decodeFileDescriptor(fd, null, opts)
}
