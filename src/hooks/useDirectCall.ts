import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceCall } from "./useVoiceCall";
import { VOICE_RECOVERY_REFRESH_MS, type VoiceRecovery } from "./useVoiceRecovery";
import { isVoiceParticipantOnDevice } from "../utils/matrix";
import { useGroupCall } from "./useGroupCall";
import type { CallPermissions } from "./useRoomCallPermissions";
import type { CallMode } from "../types/notifications";
import { useMatrixVoip } from "./useMatrixVoip";
import { getCallDuration } from "../features/chat/messages/callHistory";

type SignalKind = "ring" | "answer" | "connect" | "end" | "resume" | "resumeAccepted" | "resumeRejected";

interface CallId {
  callId: string;
  roomId: string;
  peerUserId: string;
}

interface CallSignal extends CallId {
  video?: boolean;
  silent: boolean;
  eventId: string;
  kind: SignalKind;
  deviceId: string;
  fromPeer: boolean;
  forThisDevice: boolean;
  expiresAt: number;
  requestId?: string;
  connectionLost?: boolean;
}

export interface DirectCall extends CallId {
  video?: boolean;
  silent?: boolean;
  transport?: "matrix" | "selecting" | "group";
  phase: "dialing" | "incoming" | "answering" | "connecting" | "active" | "interrupted" | "resuming";
  peerDeviceId?: string;
  ringEventId?: string;
  established?: boolean;
  connectedAt?: number;
  expiresAt: number;
}

export type DirectCallPeerConnection = "connecting" | "connected" | "interrupted" | "lost";
export type DirectCallEndAction = "decline" | "dismiss" | "end";

const RING_MS = 30_000;
const ANSWER_MS = 45_000;
const PEER_JOIN_MS = 20_000;
const RECONNECT_MS = 90_000;
const RESUME_RESPONSE_MS = 12_000;

function sendSignal(call: CallId, kind: SignalKind, options?: {
  video?: boolean;
  answerDeviceId?: string;
  targetDeviceId?: string;
  requestId?: string;
  connectionLost?: boolean;
  declined?: boolean;
  endReason?: "missed" | "failed";
  durationMs?: number;
}) {
  return invoke<void>("send_direct_call_signal", {
    roomId: call.roomId, callId: call.callId, kind, ...options,
  });
}

export function useDirectCall(
  voice: VoiceCall,
  recovery: VoiceRecovery | null,
  recoveryReady: boolean,
  remember: (record: VoiceRecovery) => void,
  forget: (roomId?: string, callId?: string) => void,
) {
  const { connect, disconnect } = voice;
  const [call, setCall] = useState<DirectCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<DirectCall | null>(null);
  const voiceBusy = useRef(false);
  voiceBusy.current = !!voice.connectedRoomId || voice.isConnecting;
  const offer = useRef<{ callId: string; sending: Promise<void> } | null>(null);
  const mediaStop = useRef<Promise<void> | null>(null);
  const outage = useRef<{ callId: string; until: number } | null>(null);
  const resumeRequest = useRef<{ id: string; resolve: (accepted: boolean | null) => void } | null>(null);
  const connections = useRef({ roomId: voice.connectedRoomId, busy: voice.isConnecting });
  connections.current = { roomId: voice.connectedRoomId, busy: voice.isConnecting };

  useEffect(() => () => {
    current.current = null;
    resumeRequest.current?.resolve(null);
  }, []);

  const update = useCallback((next: DirectCall | null) => {
    current.current = next;
    setCall(next);
  }, []);

  // A quiet invitation never reserves the phone against an explicit outgoing call or an audible ring.
  const dismissQuiet = useRef<() => void>(() => {});
  const {
    finish: finishMatrix, silence: silenceMatrix, start: startMatrix, answer: answerMatrix,
    media: matrixMedia, connection: matrixConnection, micEnabled: matrixMicEnabled, toggleMic: toggleMatrixMic,
  } = useMatrixVoip(current, voiceBusy, update, setError, recoveryReady, dismissQuiet);

  const { start: startGroup, answer: answerGroup, finish: finishGroup, silence: silenceGroup } =
    useGroupCall(voice, current, voiceBusy, update, setError, recoveryReady, dismissQuiet);

  const cameraStartedFor = useRef<string | null>(null);
  const startCamera = call?.transport === "matrix" ? matrixMedia.startCamera : voice.startCamera;
  const mediaReady = call?.transport === "matrix" || (voice.connectedRoomId === call?.roomId && !voice.isConnecting);
  useEffect(() => {
    if (!call?.video || call.phase !== "active" || current.current?.callId !== call.callId || !mediaReady
        || cameraStartedFor.current === call.callId) return;
    cameraStartedFor.current = call.callId;
    void startCamera();
  }, [call, mediaReady, startCamera]);

  const finish = useCallback((notifyPeer: boolean, options: {
    connectionLost?: boolean;
    declined?: boolean;
    endReason?: "missed" | "failed";
  } = {}) => {
    const pending = current.current;
    if (!pending) return mediaStop.current ?? finishMatrix(false);
    if (pending.transport === "group") return finishGroup(notifyPeer);
    if (pending.transport === "matrix") {
      const reason = options.connectionLost || options.endReason === "failed" ? "ice_failed" : undefined;
      return finishMatrix(notifyPeer, reason, options.declined);
    }
    update(null);
    forget(pending.roomId, pending.callId);
    outage.current = null;
    resumeRequest.current?.resolve(null);

    if (notifyPeer && pending.transport !== "selecting") {
      const ring = offer.current?.callId === pending.callId ? offer.current.sending : null;
      const durationMs = getCallDuration(pending.connectedAt);
      // A quick cancel must follow the ring, even if the request is still in flight.
      void (ring ?? Promise.resolve()).catch(() => {}).then(() => sendSignal(pending, "end", { ...options, durationMs }))
        .catch((reason) => console.warn("Could not end direct call:", reason));
    }

    if (pending.phase === "connecting" || pending.phase === "active" || pending.established) {
      const stopping = disconnect(pending.roomId).finally(() => { mediaStop.current = null; });
      mediaStop.current = stopping;
      return stopping;
    }
    return Promise.resolve();
  }, [disconnect, finishGroup, finishMatrix, forget, update]);

  dismissQuiet.current = () => {
    if (current.current?.phase === "incoming" && current.current.silent) void finish(false);
  };

  useEffect(() => {
    if (call?.phase !== "incoming") return;
    let active = true;
    let revision = 0;
    async function refresh() {
      const pending = current.current;
      if (!active || !pending || pending !== call) return;
      const request = ++revision;
      const mode = await invoke<CallMode>("get_incoming_call_mode", {
        roomId: pending.roomId, peerUserId: pending.peerUserId,
        kind: pending.transport === "group" ? "group" : pending.transport === "matrix" ? "member" : "liveKit",
      }).catch(() => "block");
      if (!active || request !== revision || current.current !== pending) return;
      if (mode === "block") { void finish(false); return; }
      const silent = mode === "silent";
      if (silent === !!pending.silent) return;
      if (pending.transport === "group") silenceGroup(silent);
      else if (pending.transport === "matrix") silenceMatrix(silent);
      else update({ ...pending, silent });
    }
    const subscriptions = [
      listen("pax-notification-settings-changed", refresh),
      listen("pax-notification-settings-invalidated", refresh),
      listen("ignored-users-changed", refresh),
      listen<string>("room-call-permissions-changed", ({ payload }) => { if (payload === call.roomId) void refresh(); }),
      listen<{ roomId: string }>("room-members-changed", ({ payload }) => { if (payload.roomId === call.roomId) void refresh(); }),
    ];
    void Promise.allSettled(subscriptions).then(refresh);
    return () => {
      active = false;
      for (const subscription of subscriptions) void subscription.then(remove => remove()).catch(() => {});
    };
  }, [call, finish, silenceGroup, silenceMatrix, update]);

  const end = useCallback(() => finish(!(current.current?.phase === "incoming" && current.current.silent)), [finish]);
  const decline = useCallback(() => {
    if (current.current?.phase === "incoming") return finish(true, { declined: true });
  }, [finish]);

  const connectMedia = useCallback(async (pending: DirectCall, answeringDevice?: string) => {
    const connecting = { ...pending, phase: "connecting" } as const;
    update(connecting);
    const joined = await connect(pending.roomId, { replaceOtherSessions: false });
    if (current.current !== connecting) return;

    if (!joined) {
      void finish(true, { endReason: "failed" });
      setError("Could not connect the voice call.");
      return;
    }

    if (answeringDevice) {
      try {
        // Publish the caller's voice membership before the answerer looks up the call's focus.
        await sendSignal(connecting, "connect", { answerDeviceId: answeringDevice });
      } catch (reason) {
        if (current.current === connecting) {
          void finish(true, { endReason: "failed" });
          setError(String(reason));
        }
        return;
      }
    }
    if (current.current === connecting) update({ ...connecting, phase: "active" });
  }, [connect, finish, update]);

  const checkResume = useCallback((pending: DirectCall) => {
    resumeRequest.current?.resolve(null);
    return new Promise<boolean | null>((resolve) => {
      const id = crypto.randomUUID();
      const request = { id, resolve: (accepted: boolean | null) => {
        clearTimeout(timer);
        if (resumeRequest.current === request) resumeRequest.current = null;
        resolve(accepted);
      } };
      const timer = setTimeout(() => request.resolve(null), RESUME_RESPONSE_MS);
      resumeRequest.current = request;
      void sendSignal(pending, "resume", { targetDeviceId: pending.peerDeviceId, requestId: id })
        .catch(() => request.resolve(null));
    });
  }, []);

  const reconnect = useCallback(async (onStarted?: (roomId: string) => void) => {
    const pending = current.current;
    if (!pending?.established || pending.transport === "matrix" || connections.current.busy || pending.phase === "resuming" ||
        !pending.peerDeviceId || connections.current.roomId !== null) return;
    if (outage.current && outage.current.until <= Date.now()) return;
    const resuming = { ...pending, phase: "resuming" } as const;
    update(resuming);
    setError(null);
    onStarted?.(resuming.roomId);
    const accepted = await checkResume(resuming);
    if (current.current !== resuming) return;
    if (accepted === false) {
      void finish(false);
      setError("The call has already ended.");
      return;
    }
    if (accepted === true) {
      const joined = await connect(resuming.roomId, { forceReconnect: true, replaceOtherSessions: false });
      if (current.current !== resuming) return;
      if (joined) {
        update({ ...resuming, phase: "active" });
        return;
      }
    }
    update({ ...resuming, phase: "interrupted" });
    setError("Could not reconnect. Try again.");
  }, [checkResume, connect, finish, update]);

  const receive = useCallback((signal: CallSignal) => {
    if (signal.expiresAt <= Date.now()) return;
    if (signal.kind === "ring" && signal.fromPeer && !signal.silent) dismissQuiet.current();
    const pending = current.current;
    if (pending?.transport === "matrix" || pending?.transport === "group") return;
    const matches = pending?.callId === signal.callId && pending.roomId === signal.roomId &&
      pending.peerUserId === signal.peerUserId && pending.peerDeviceId === signal.deviceId;
    if (signal.kind === "resume") {
      if (!signal.fromPeer || !signal.requestId) return;
      const until = outage.current?.until;
      if (matches && until !== undefined && until <= Date.now()) return;
      const accepted = matches && pending?.established;
      void sendSignal(signal, accepted ? "resumeAccepted" : "resumeRejected", {
        targetDeviceId: signal.deviceId, requestId: signal.requestId,
      }).catch((error) => console.warn("Could not answer call recovery:", error));
      return;
    }
    if (signal.kind === "resumeAccepted" || signal.kind === "resumeRejected") {
      const request = resumeRequest.current;
      if (signal.fromPeer && matches && request && signal.requestId === request.id) {
        request.resolve(signal.kind === "resumeAccepted");
      }
      return;
    }
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
        ringEventId: signal.eventId,
        phase: "incoming",
        video: signal.video,
        silent: signal.silent,
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
        else if (signal.connectionLost && pending.established) setError("Call ended. Connection lost.");
      }
    } else if (signal.kind === "answer") {
      if (!signal.fromPeer && pending.phase === "incoming") {
        void finish(false);
      } else if (signal.fromPeer && pending.phase === "dialing" && pending.expiresAt > Date.now()) {
        void connectMedia({ ...pending, peerDeviceId: signal.deviceId }, signal.deviceId);
      }
    } else if (signal.kind === "connect" && signal.fromPeer && (pending.phase === "answering" || pending.phase === "incoming")) {
      if (signal.forThisDevice && pending.phase === "answering" && pending.expiresAt > Date.now()) {
        void connectMedia(pending);
      } else {
        void finish(false);
      }
    }
  }, [connectMedia, finish, update]);

  useEffect(() => {
    if (!recovery?.direct || current.current || voiceBusy.current || recovery.expiresAt <= Date.now()) return;
    const restored = {
      ...recovery.direct,
      roomId: recovery.roomId,
      expiresAt: recovery.expiresAt,
      phase: "interrupted",
      established: true,
    } as const;
    outage.current = { callId: restored.callId, until: restored.expiresAt };
    update(restored);
    void checkResume(restored).then((accepted) => {
      if (accepted === false && current.current === restored) void finish(false);
    });
  }, [checkResume, finish, recovery, update]);

  useEffect(() => {
    if (!recoveryReady) return;
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
  }, [receive, recoveryReady]);

  useEffect(() => {
    if (!call || call.transport === "group" || call.established || call.phase === "connecting" || call.phase === "active"
        || (call.transport === "matrix" && call.phase === "dialing")) return;
    const timer = setTimeout(() => {
      if (current.current !== call) return;
      void finish(call.phase === "dialing", { endReason: "missed" });
      if (call.phase === "dialing") setError("No answer.");
      if (call.phase === "answering") setError("The call could not be answered in time.");
    }, Math.max(0, call.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [call, finish]);

  const inCall = !call?.transport && call?.phase === "active"
    && voice.connectedRoomId === call.roomId && !voice.isConnecting;
  const peer = inCall ? voice.remoteParticipants.find(({ identity }) =>
      isVoiceParticipantOnDevice(identity, call.peerUserId, call.peerDeviceId),
    ) : undefined;
  // A quality update leaves the peer in the roster. Only their removal starts
  // the reconnect window while our own connection is healthy.
  const peerJoined = peer !== undefined;
  useEffect(() => {
    if (!call || call.transport || (!call.established && call.phase !== "active")) return;
    if (peerJoined) {
      outage.current = null;
      if (!call.established) {
        update({ ...call, established: true, connectedAt: Date.now() });
        return;
      }
      if (!call.peerDeviceId) return;
      const direct = {
        callId: call.callId, peerUserId: call.peerUserId, peerDeviceId: call.peerDeviceId, connectedAt: call.connectedAt,
      };
      const save = () => remember({
        roomId: call.roomId, direct, expiresAt: Date.now() + RECONNECT_MS + 2 * VOICE_RECOVERY_REFRESH_MS,
      });
      save();
      const timer = setInterval(save, VOICE_RECOVERY_REFRESH_MS);
      return () => clearInterval(timer);
    }
    if (!call.established && voice.isConnecting) return;
    if (outage.current?.callId !== call.callId) {
      const until = Date.now() + (call.established ? RECONNECT_MS : PEER_JOIN_MS);
      outage.current = { callId: call.callId, until };
      if (call.established && call.peerDeviceId) {
        remember({ roomId: call.roomId, expiresAt: until, direct: {
          callId: call.callId, peerUserId: call.peerUserId, peerDeviceId: call.peerDeviceId, connectedAt: call.connectedAt,
        } });
      }
    }
    const timer = setTimeout(() => {
      if (current.current !== call) return;
      void finish(call.phase !== "interrupted", { connectionLost: !!call.established, endReason: "failed" });
      setError(call.established ? "Call ended. Connection lost." : "Could not connect to the other person.");
    }, Math.max(0, outage.current.until - Date.now()));
    return () => clearTimeout(timer);
  }, [call, finish, peerJoined, remember, update, voice.isConnecting]);

  useEffect(() => {
    if (call && !call.transport && voice.endedRoomId === call.roomId) {
      void finish(true);
      setError("The voice session ended on this device.");
    }
  }, [call, finish, voice.endedRoomId]);

  const start = useCallback((roomId: string, peerUserId: string, { memberCall = false, video = false } = {}) => {
    dismissQuiet.current();
    if (current.current || voiceBusy.current || mediaStop.current) return;
    const pending: DirectCall = {
      roomId, peerUserId, callId: crypto.randomUUID(), phase: "dialing", expiresAt: Date.now() + RING_MS,
      transport: "selecting", video,
    };
    setError(null);
    update(pending);
    void (async () => {
      const permissions = await invoke<CallPermissions>("get_room_call_permissions", { roomId, peerUserId });
      if (current.current !== pending) return;
      if (!permissions.member) throw new Error("This call is unavailable with the current membership or room permissions.");
      const useLiveKit = !memberCall && await invoke<boolean>("prefer_livekit_call", { roomId, peerUserId }).catch(() => false);
      if (current.current !== pending) return;
      if (!useLiveKit) {
        startMatrix({ ...pending, transport: "matrix" });
        return;
      }
      const ringing = { ...pending, expiresAt: Date.now() + RING_MS, transport: undefined };
      update(ringing);
      const sending = sendSignal(ringing, "ring", { video });
      offer.current = { callId: ringing.callId, sending };
      try {
        await sending;
      } catch (reason) {
        if (current.current !== ringing) return;
        void finish(true);
        setError(String(reason));
      } finally {
        if (offer.current?.sending === sending) offer.current = null;
      }
    })().catch((reason) => {
      if (current.current !== pending) return;
      void finish(false);
      setError(String(reason));
    });
  }, [finish, startMatrix, update]);

  const answer = useCallback((onStarted?: (roomId: string) => void, expectedCallId?: string) => {
    const pending = current.current;
    if (pending?.phase !== "incoming" || pending.expiresAt <= Date.now() || voiceBusy.current) return;
    if (expectedCallId && pending.callId !== expectedCallId) return;
    if (pending.transport === "group") {
      answerGroup(onStarted);
      return;
    }
    if (pending.transport === "matrix") {
      answerMatrix(onStarted);
      return;
    }
    const answering = { ...pending, phase: "answering", expiresAt: Date.now() + ANSWER_MS } as const;
    update(answering);
    onStarted?.(answering.roomId);
    void sendSignal(answering, "answer").catch((reason) => {
      if (current.current !== answering) return;
      void finish(true);
      setError(String(reason));
    });
  }, [answerGroup, answerMatrix, finish, update]);

  const endFromNotification = useCallback((callId: string, action: DirectCallEndAction) => {
    const pending = current.current;
    if (pending?.callId !== callId) return;
    if (pending.phase === "incoming" ? pending.expiresAt <= Date.now() : action !== "end") return;
    void finish(action !== "dismiss", { declined: action === "decline" });
  }, [finish]);

  const clearError = useCallback(() => setError(null), []);
  const peerConnection: DirectCallPeerConnection = call?.transport === "group" ? (call.phase === "active" ? "connected" : "connecting")
    : call?.transport === "matrix" ? matrixConnection : peer
    ? peer.connectionInterrupted && call?.established ? "interrupted" : "connected"
    : inCall && call.established ? "lost" : "connecting";
  return {
    call, error, peerConnection, matrixMedia, reconnect, start, startGroup, answer, end, decline, endFromNotification, clearError,
    isMicEnabled: call?.transport === "matrix" ? matrixMicEnabled : voice.isMicEnabled,
    toggleMic: call?.transport === "matrix" ? toggleMatrixMic : voice.toggleMic,
  };
}
