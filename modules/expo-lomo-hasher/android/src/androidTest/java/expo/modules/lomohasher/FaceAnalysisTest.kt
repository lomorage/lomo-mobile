package expo.modules.lomohasher

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import android.content.ContentValues
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.nio.FloatBuffer

/**
 * A camera original used to be decoded at full size before face recognition.
 * This checks the subsample, and, when the face model is on the device, that
 * creating a session and running one embedding does not kill the process.
 *
 * Push the model first if you want the second check:
 *   adb push w600k_r50.onnx /data/local/tmp/w600k_r50.onnx
 */
@RunWith(AndroidJUnit4::class)
class FaceAnalysisTest {

  @Test
  fun largeJpeg_isDecodedUnder2048() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = File(context.cacheDir, "large-analysis-src.jpg")
    val big = Bitmap.createBitmap(5000, 4000, Bitmap.Config.ARGB_8888)
    try {
      FileOutputStream(file).use { out ->
        assertTrue(big.compress(Bitmap.CompressFormat.JPEG, 40, out))
      }
    } finally {
      big.recycle()
    }

    val decoded = decodeAnalysisBitmap(context, Uri.fromFile(file))
    try {
      val longEdge = maxOf(decoded.bitmap.width, decoded.bitmap.height)
      // sample 4 of 5000 is 1250. 2048 would mean the full frame was decoded
      // and only then scaled, which is the crash on a 50MP photo.
      assertTrue("decoded ${decoded.bitmap.width}x${decoded.bitmap.height}", longEdge < 1800)
      assertTrue(longEdge >= 1000)
      // scale maps this bitmap back onto the original oriented width
      assertEquals(5000f, decoded.bitmap.width / decoded.scaleX, 2f)
      assertEquals(4000f, decoded.bitmap.height / decoded.scaleY, 2f)
    } finally {
      decoded.bitmap.recycle()
      file.delete()
    }
  }

  // file:// can seek, so the test above does not catch the MediaStore bug.
  // A content:// stream cannot, and decodeStream then ignores inSampleSize.
  @Test
  fun contentUri_largeJpeg_isDecodedUnder2048() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, "lomo-face-probe-${System.currentTimeMillis()}.jpg")
      put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(MediaStore.Images.Media.RELATIVE_PATH, "DCIM/Camera")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
    }
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
    assertTrue("MediaStore insert failed", uri != null)
    try {
      val big = Bitmap.createBitmap(5000, 4000, Bitmap.Config.ARGB_8888)
      try {
        val out = resolver.openOutputStream(uri!!) ?: throw AssertionError("no output stream")
        out.use { assertTrue(big.compress(Bitmap.CompressFormat.JPEG, 40, it)) }
      } finally {
        big.recycle()
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        resolver.update(uri, ContentValues().apply {
          put(MediaStore.Images.Media.IS_PENDING, 0)
        }, null, null)
      }

      val decoded = decodeAnalysisBitmap(context, uri)
      try {
        val longEdge = maxOf(decoded.bitmap.width, decoded.bitmap.height)
        assertTrue("content decoded ${decoded.bitmap.width}x${decoded.bitmap.height}", longEdge < 1800)
        assertTrue(longEdge >= 1000)
        assertEquals(5000f, decoded.bitmap.width / decoded.scaleX, 2f)
        assertEquals(4000f, decoded.bitmap.height / decoded.scaleY, 2f)
      } finally {
        decoded.bitmap.recycle()
      }

      val clip = decodeToward(context, uri, 320)
      try {
        assertTrue("clip decoded ${clip.width}x${clip.height}", clip.width < 1200 && clip.height < 1200)
        assertTrue(clip.width >= 400 && clip.height >= 300)
      } finally {
        clip.recycle()
      }
    } finally {
      resolver.delete(uri!!, null, null)
    }
  }

  @Test
  fun faceModel_runsOneEmbeddingWithoutCrashing() {
    val model = File("/data/local/tmp/w600k_r50.onnx")
    if (!model.exists() || model.length() < 100_000_000L) {
      Log.w("FaceAnalysisTest", "Skipping ONNX run; model not at ${model.path}")
      return
    }
    val env = OrtEnvironment.getEnvironment()
    env.createSession(model.absolutePath, cpuSessionOptions()).use { session ->
      val inputName = session.inputNames.iterator().next()
      val data = FloatBuffer.allocate(3 * 112 * 112)
      val tensor = OnnxTensor.createTensor(env, data, longArrayOf(1, 3, 112, 112))
      tensor.use {
        session.run(java.util.Collections.singletonMap(inputName, tensor)).use { outputs ->
          val raw = (outputs.get(0).value as Array<FloatArray>)[0]
          assertEquals(512, raw.size)
        }
      }
    }
  }
}
