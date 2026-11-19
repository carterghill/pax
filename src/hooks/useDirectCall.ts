import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceCall } from "./useVoiceCall";

type SignalKind = "ring" | "answer" | "connect" | "end";

interface CallId {
  callId: string;
  roomId: string;
  peerUserId: string;
}

interface CallSignal extends CallId {
  kind: SignalKind;
  deviceId: string;
  fromPeer: boolean;
  forThisDevice: boolean;
  expiresAt: number;
}

export interface DirectCall extends CallId {
  phase: "dialing" | "incoming" | "answering" | "connecting" | "active";
  peerDeviceId?: string;
  expiresAt: number;
}

const RING_MS = 30_000;
const ANSWER_MS = 45_000;
const PEER_JOIN_MS = 20_000;

function sendSignal(call: CallId, kind: SignalKind, answerDeviceId?: string) {
  return invoke<void>("send_direct_call_signal", {
    roomId: call.roomId, callId: call.callId, kind, answerDeviceId,
  });
}

export function useDirectCall(voice: VoiceCall) {
  const { connect, disconnect } = voice;
  const [call, setCall] = useState<DirectCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<DirectCall | null>(null);
  const voiceBusy = useRef(false);
  voiceBusy.current = !!voice.connectedRoomId || voice.isConnecting;
  const offer = useRef<{ callId: string; sending: Promise<void> } | null>(null);
  const mediaStart = useRef<Promise<boolean> | null>(null);
  const mediaStop = useRef<Promise<void> | null>(null);

  const update = useCallback((next: DirectCall | null) => {
    current.current = next;
    setCall(next);
  }, []);

  const finish = useCallback((notifyPeer: boolean) => {
    const pending = current.current;
    if (!pending) return mediaStop.current ?? Promise.resolve();
    update(null);

    if (notifyPeer) {
      const ring = offer.current?.callId === pending.callId ? offer.current.sending : null;
      // A quick cancel must follow the ring, even if the request is still in flight.
      void (ring ?? Promise.resolve()).catch(() => {}).then(() => sendSignal(pending, "end"))
        .catch((reason) => console.warn("Could not end direct call:", reason));
    }

    if (pending.phase === "connecting" || pending.phase === "active") {
      const stopping = (mediaStart.current ?? Promise.resolve(true)).then(async (joined) => {
        if (joined) await disconnect(pending.roomId);
      }).finally(() => { mediaStop.current = null; });
      mediaStop.current = stopping;
      return stopping;
    }
    return Promise.resolve();
  }, [disconnect, update]);

  const end = useCallback(() => finish(true), [finish]);

  const connectMedia = useCallback(async (pending: DirectCall, answeringDevice?: string) => {
    const connecting = { ...pending, phase: "connecting" } as const;
    update(connecting);
    const joining = connect(pending.roomId, { replaceOtherSessions: false });
    mediaStart.current = joining;
    const joined = await joining;
    if (mediaStart.current === joining) mediaStart.current = null;
    if (current.current !== connecting) return;

    if (!joined) {
      void finish(true);
      setError("Could not connect the voice call.");
      return;
    }

    if (answeringDevice) {
      try {
        // Publish the caller's voice membership before the answerer looks up the call's focus.
        await sendSignal(connecting, "connect", answeringDevice);
      } catch (reason) {
        if (current.current === connecting) {
          void finish(true);
          setError(String(reason));
        }
        return;
      }
    }
    if (current.current === connecting) update({ ...connecting, phase: "active" });
  }, [connect, finish, update]);

  const receive = useCallback((signal: CallSignal) => {
    if (signal.expiresAt <= Date.now()) return;
    const pending = current.current;
    if (signal.kind === "ring") {
      if (!signal.fromPeer || voiceBusy.current || mediaStop.current) return;
      // Resolve crossed calls the same way on both ends.
      if (pending && (pending.phase !== "dialing" || pending.roomId !== signal.roomId
          || pending.callId <= signal.callId)) return;
      setError(null);
      update({
        callId: signal.callId,
        roomId: signal.roomId,
        peerUserId: signal.peerUserId,
        peerDeviceId: signal.deviceId,
        phase: "incoming",
        expiresAt: signal.expiresAt,
      });
      return;
    }

    if (!pending || pending.callId !== signal.callId || pending.roomId !== signal.roomId) return;
    if (signal.fromPeer && pending.peerDeviceId && signal.deviceId !== pending.peerDeviceId) return;

    if (signal.kind === "end") {
      if (signal.fromPeer || pending.phase === "incoming" || pending.phase === "answering") {
        void finish(false);
        if (pending.phase === "dialing") setError("Call declined.");
      }
    } else if (signal.kind === "answer") {
      if (!signal.fromPeer && pending.phase === "incoming") {
        void finish(false);
      } else if (signal.fromPeer && pending.phase === "dialing" && pending.expiresAt > Date.now()) {
        void connectMedia({ ...pending, peerDeviceId: signal.deviceId }, signal.deviceId);
      }
    } else if (signal.fromPeer && (pending.phase === "answering" || pending.phase === "incoming")) {
      if (signal.forThisDevice && pending.phase === "answering" && pending.expiresAt > Date.now()) {
        void connectMedia(pending);
      } else {
        void finish(false);
      }
    }
  }, [connectMedia, finish, update]);

  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    let reading = false;
    let needsRead = false;
    async function readSignals() {
      needsRead = true;
      if (reading || disposed) return;
      reading = true;
      try {
        while (needsRead && !disposed) {
          needsRead = false;
          const signals = await invoke<CallSignal[]>("take_direct_call_signals");
          if (!disposed) signals.forEach(receive);
        }
      } catch (reason) {
        if (!disposed) console.error("Could not read direct call requests:", reason);
      } finally {
        reading = false;
      }
    }
    void listen("direct-call-signals", readSignals).then((unlisten) => {
      if (disposed) unlisten();
      else {
        stop = unlisten;
        void readSignals();
      }
    }).catch((reason) => console.error("Could not listen for direct calls:", reason));
    return () => { disposed = true; stop?.(); };
  }, [receive]);

  useEffect(() => {
    if (!call || call.phase === "connecting" || call.phase === "active") return;
    const timer = setTimeout(() => {
      if (current.current !== call) return;
      void finish(call.phase === "dialing");
      if (call.phase === "dialing") setError("No answer.");
      if (call.phase === "answering") setError("The call could not be answered in time.");
    }, Math.max(0, call.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [call, finish]);

  const peerJoined = call?.phase === "active" && voice.connectedRoomId === call.roomId
    && voice.remoteParticipants.some(({ identity }) => identity === call.peerUserId
      || identity.startsWith(`${call.peerUserId}:`) || identity.startsWith(`${call.peerUserId}|`));
  useEffect(() => {
    if (call?.phase !== "active" || voice.isConnecting || peerJoined) return;
    const timer = setTimeout(() => {
      if (current.current !== call) return;
      void finish(true);
      if (voice.connectedRoomId !== call.roomId) setError("The voice connection was lost.");
    }, PEER_JOIN_MS);
    return () => clearTimeout(timer);
  }, [call, finish, peerJoined, voice.connectedRoomId, voice.isConnecting]);

  const start = useCallback((roomId: string, peerUserId: string) => {
    if (current.current || voiceBusy.current || mediaStop.current) return;
    const pending: DirectCall = {
      roomId, peerUserId, callId: crypto.randomUUID(), phase: "dialing", expiresAt: Date.now() + RING_MS,
    };
    setError(null);
    update(pending);
    const sending = sendSignal(pending, "ring");
    offer.current = { callId: pending.callId, sending };
    void sending.catch((reason) => {
      if (current.current !== pending) return;
      void finish(true);
      setError(String(reason));
    }).finally(() => {
      if (offer.current?.sending === sending) offer.current = null;
    });
  }, [finish, update]);

  const answer = useCallback(() => {
    const pending = current.current;
    if (pending?.phase !== "incoming" || pending.expiresAt <= Date.now() || voiceBusy.current) return;
    const answering = { ...pending, phase: "answering", expiresAt: Date.now() + ANSWER_MS } as const;
    update(answering);
    void sendSignal(answering, "answer").catch((reason) => {
      if (current.current !== answering) return;
      void finish(true);
      setError(String(reason));
    });
  }, [finish, update]);

  const clearError = useCallback(() => setError(null), []);
  return { call, error, peerJoined, start, answer, end, clearError };
}
