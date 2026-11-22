package com.carter.pax

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Android Keystore protects the random key that Matrix uses to encrypt its database. */
object PaxStoreKey {
    private const val alias = "com.carter.pax.matrix-crypto-v1"
    private const val nonceBytes = 12
    private const val keyBytes = 32
    private const val tagBits = 128

    @JvmStatic
    fun open(path: String, create: Boolean): ByteArray? {
        val pathOnDisk = File(path)
        val file = AtomicFile(pathOnDisk)
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val wrapped = try {
            file.readFully()
        } catch (error: FileNotFoundException) {
            if (pathOnDisk.exists()) throw error
            null
        }
        if (wrapped != null) {
            val wrappingKey = keyStore.getKey(alias, null) as? SecretKey
                ?: error("The Matrix database wrapping key is missing.")
            require(wrapped.size == nonceBytes + keyBytes + tagBits / 8)
            val nonce = GCMParameterSpec(tagBits, wrapped, 0, nonceBytes)
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey, nonce)
            return cipher.doFinal(wrapped, nonceBytes, wrapped.size - nonceBytes)
        }
        if (!create) return null

        val wrappingKey = keyStore.getKey(alias, null) as? SecretKey
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(KeyGenParameterSpec.Builder(
                    alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build())
                generateKey()
            }
        val bytes = ByteArray(keyBytes).also { SecureRandom().nextBytes(it) }
        try {
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
            require(cipher.iv.size == nonceBytes)
            val encrypted = cipher.iv + cipher.doFinal(bytes)
            val output = file.startWrite()
            try {
                output.write(encrypted)
                file.finishWrite(output)
            } catch (error: Exception) {
                file.failWrite(output)
                throw error
            }
        } finally {
            bytes.fill(0)
        }
        return open(path, false)
    }
}
