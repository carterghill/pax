package com.carter.pax

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PaxMessagePreviewTest {
    @Test
    fun showsDecryptedTextInPreferenceToPushContent() {
        assertEquals("Lunch?", PaxMessagePreview.notificationBody(true, "Lunch?", "fallback"))
    }

    @Test
    fun usesAvailablePlaintextOrTheGenericBody() {
        val payload = PaxMessagePreview.payloadBody(mapOf("content_body" to "  Lunch?  "))
        assertEquals("Lunch?", PaxMessagePreview.notificationBody(true, " ", payload))
        val encrypted = PaxMessagePreview.payloadBody(mapOf("type" to "m.room.encrypted", "content_body" to "envelope"))
        assertNull(encrypted)
        assertEquals("New message", PaxMessagePreview.notificationBody(true, null, encrypted))
    }

    @Test
    fun hidesDecryptedAndPushTextWhenPreviewsAreOff() {
        assertEquals("New message", PaxMessagePreview.notificationBody(false, "private", null))
        assertEquals("New message", PaxMessagePreview.notificationBody(false, null, "private"))
    }

    @Test
    fun directChatsShowOnlyTheSenderEvenWhenRenamed() {
        val header = PaxMessagePreview.header("caesar", "Weekend plans", isDirect = true)
        assertEquals("caesar", header.title)
        assertNull(header.subText)
    }

    @Test
    fun roomNotificationsPutTheRoomInSecondaryHeaderText() {
        val header = PaxMessagePreview.header("caesar", "Kitchen", isDirect = false)
        assertEquals("caesar", header.title)
        assertEquals("Kitchen", header.subText)
        assertEquals("caesar", PaxMessagePreview.header("caesar", "caesar", isDirect = false).subText)
    }

    @Test
    fun incompletePushesUseAvailableLabelsWithoutRepeatingThem() {
        assertNull(PaxMessagePreview.header("caesar", "Caesar", isDirect = null).subText)
        assertEquals("#kitchen:pax", PaxMessagePreview.header("caesar", "#kitchen:pax", isDirect = null).subText)
        assertEquals(PaxMessagePreview.Header("Kitchen", null), PaxMessagePreview.header(null, "Kitchen", null))
        assertEquals(PaxMessagePreview.Header("Someone", null), PaxMessagePreview.header(null, null, null))
    }
}
