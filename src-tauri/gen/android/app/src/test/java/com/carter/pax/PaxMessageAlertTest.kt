package com.carter.pax

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaxMessageAlertTest {
    @Test
    fun confirmedMessagesCanPopUpWithoutAMatrixSoundTweak() {
        for (type in listOf("m.room.message", "m.room.encrypted", null)) {
            assertFalse(shouldPostSilently(type, "message", soundRequested = false))
        }
    }

    @Test
    fun roomFormattingDoesNotChangeDelivery() {
        for (kind in listOf("room", null)) {
            assertFalse(shouldPostSilently("m.room.message", kind, soundRequested = false))
            assertTrue(shouldPostSilently("m.room.encrypted", kind, soundRequested = false))
            assertTrue(shouldPostSilently(null, kind, soundRequested = false))
        }
    }

    @Test
    fun otherResolvedEventsKeepTheirPushRuleBehavior() {
        assertTrue(shouldPostSilently("m.room.encrypted", "event", soundRequested = false))
        assertFalse(shouldPostSilently("m.room.encrypted", "event", soundRequested = true))
    }
}
