package expo.modules.lomohasher

import android.content.ContentUris
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest

/**
 * Instrumented test that hashes the problematic PXL file both ways and compares results.
 *
 * Run with: ./gradlew :modules:expo-lomo-hasher:connectedAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class HashConsistencyTest {

    // KNOWN CORRECT hash from server and PC certutil
    private val EXPECTED_HASH = "cedcccf9abd9b04164ae31b9d00bac765c97aa94"
    private val TARGET_FILENAME = "PXL_20260313_005404073.jpg"

    private fun hashInputStream(inputStream: InputStream): String {
        val digest = MessageDigest.getInstance("SHA-1")
        val buffer = ByteArray(1024 * 1024) // 1MB
        var totalBytes = 0L
        try {
            while (true) {
                val read = inputStream.read(buffer)
                if (read == -1) break
                digest.update(buffer, 0, read)
                totalBytes += read
            }
        } finally {
            inputStream.close()
        }
        Log.d("HashTest", "Total bytes read: $totalBytes")
        return digest.digest().joinToString("") { String.format("%02x", it.toInt() and 0xff) }
    }

    /**
     * Finds the content URI for the target file in MediaStore.
     */
    private fun findContentUri(): Uri? {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }

        val projection = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME)
        val selection = "${MediaStore.Images.Media.DISPLAY_NAME} = ?"
        val selectionArgs = arrayOf(TARGET_FILENAME)

        context.contentResolver.query(collection, projection, selection, selectionArgs, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID))
                return ContentUris.withAppendedId(collection, id)
            }
        }
        return null
    }

    @Test
    fun fileHashViaDirectPath_matchesExpected() {
        val file = File("/sdcard/DCIM/Camera/$TARGET_FILENAME")
        if (!file.exists()) {
            Log.w("HashTest", "File not on /sdcard/DCIM/Camera/, skipping direct-path test")
            return
        }
        val hash = hashInputStream(FileInputStream(file))
        Log.d("HashTest", "Direct FileInputStream hash: $hash")
        assertEquals("Direct file hash should match server!", EXPECTED_HASH, hash)
    }

    @Test
    fun contentUriHash_withoutRequireOriginal_showsBug() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val contentUri = findContentUri()
        assertNotNull("Target file must exist in MediaStore: $TARGET_FILENAME", contentUri)

        val stream = context.contentResolver.openInputStream(contentUri!!)!!
        val hash = hashInputStream(stream)
        Log.d("HashTest", "ContentResolver (raw) hash: $hash")
        // We EXPECT this to be WRONG (redacted) — this documents the bug
        Log.d("HashTest", "Raw content hash matches expected? ${hash == EXPECTED_HASH}")
    }

    @Test
    fun contentUriHash_withRequireOriginal_matchesExpected() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val contentUri = findContentUri()
        assertNotNull("Target file must exist in MediaStore: $TARGET_FILENAME", contentUri)

        val originalUri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.setRequireOriginal(contentUri!!)
        } else {
            contentUri!!
        }

        val stream = context.contentResolver.openInputStream(originalUri)!!
        val hash = hashInputStream(stream)
        Log.d("HashTest", "ContentResolver (requireOriginal) hash: $hash")
        assertEquals("Hash with setRequireOriginal must match server!", EXPECTED_HASH, hash)
    }
}
