import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DirectCall, DirectCallPeerConnection } from "./useDirectCall";
import { getStoredAudioDevicePreferences, requestMicrophonePermission } from "./useVoiceAudioDevices";
import { getCallDuration } from "../features/chat/messages/callHistory";

const INVITE_LIFETIME = 90_000;
const CONNECTION_TIMEOUT = 35_000;
const ICE_BATCH_DELAY = 250;

interface Description {
  type: "offer" | "answer";
  sdp: string;
}

interface Candidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

type SignalKind =
  | "m.call.invite" | "m.call.answer" | "m.call.candidates" | "m.call.select_answer"
  | "m.call.reject" | "m.call.hangup" | "m.call.negotiate";

interface WireSignal {
  silent: boolean;
  kind: SignalKind;
  roomId: string;
  eventId: string;
  expiresAt: number;
  sender: string;
  fromPeer: boolean;
  localParty: string;
  notificationId: string;
  content: {
    call_id: string;
    party_id?: string;
    version: string | number;
    offer?: Description;
    answer?: Description;
    description?: Description;
    candidates?: Candidate[];
    selected_party_id?: string;
  };
}

interface Session {
  call: DirectCall;
  wireId: string;
  version: 0 | 1;
  fromInvite: boolean;
  offer?: Description;
  remoteParty?: string;
  remoteReady: boolean;
  remoteCandidates: Map<string, Candidate[]>;
  localCandidates: Candidate[];
  published: boolean;
  publication?: Promise<void>;
  iceTimer?: ReturnType<typeof setTimeout>;
  iceSending?: Promise<void>;
  deadline?: ReturnType<typeof setTimeout>;
}

function signal(session: Session, kind: SignalKind, content: object = {}) {
  return invoke<void>("send_matrix_voip_signal", {
    roomId: session.call.roomId, callId: session.wireId, version: session.version,
    kind, content, peerUserId: session.call.peerUserId,
  });
}

function openMedia(session: Session) {
  return invoke<Description>("open_matrix_voip_media", {
    roomId: session.call.roomId, callId: session.call.callId, peerUserId: session.call.peerUserId, offer: session.offer,
  });
}

function closeMedia(session: Session) {
  return invoke<void>("close_matrix_voip_media", { callId: session.call.callId });
}

function validDescription(value: Description | undefined): value is Description {
  return !!value && (value.type === "answer" || value.type === "offer")
    && typeof value.sdp === "string" && value.sdp.length > 0 && value.sdp.length <= 65_536;
}

function candidatesFrom(value: Candidate[] | undefined): Candidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).filter((item) => item && typeof item.candidate === "string"
    && item.candidate.length <= 2_048
    && (item.sdpMid == null || typeof item.sdpMid === "string")
    && (item.sdpMLineIndex == null || Number.isInteger(item.sdpMLineIndex)));
}

function newSession(call: DirectCall, wireId: string, version: 0 | 1, offer?: Description, remoteParty?: string): Session {
  return {
    call, wireId, version, fromInvite: !!offer, offer, remoteParty, remoteReady: false,
    remoteCandidates: new Map(), localCandidates: [], published: false,
  };
}

export function useMatrixVoip(
  current: RefObject<DirectCall | null>,
  voiceBusy: RefObject<boolean>,
  update: (call: DirectCall | null) => void,
  setError: (reason: string | null) => void,
  ready: boolean,
  dismissQuiet: RefObject<() => void>,
) {
  const active = useRef<Session | null>(null);
  const stopping = useRef<Promise<void> | null>(null);
  const seen = useRef(new Set<string>());
  const [micEnabled, setMicEnabled] = useState(true);
  const [connection, setConnection] = useState<DirectCallPeerConnection>("connecting");

  const setPhase = useCallback((session: Session, phase: DirectCall["phase"], expiresAt = session.call.expiresAt) => {
    session.call = {
      ...session.call, phase, expiresAt, established: session.call.established || phase === "active",
      connectedAt: session.call.connectedAt ?? (phase === "active" ? Date.now() : undefined),
    };
    update(session.call);
  }, [update]);

  const finish = useCallback((notifyPeer: boolean, reason = "user_hangup", declined = false) => {
    const session = active.current;
    if (!session) return stopping.current ?? Promise.resolve();
    active.current = null;
    clearTimeout(session.deadline);
    clearTimeout(session.iceTimer);
    update(null);
    const dismissing = session.fromInvite && session.call.phase === "incoming";
    const durationMs = getCallDuration(session.call.connectedAt);
    if (notifyPeer && (session.fromInvite || session.publication)) {
      void (session.publication ?? Promise.resolve()).catch(() => {})
        .then(() => dismissing && session.version === 1
          ? signal(session, "m.call.reject")
          : signal(session, "m.call.hangup", {
            reason,
            "com.carter.pax.declined": declined || undefined,
            "com.carter.pax.duration_ms": durationMs,
          }))
        .catch((error) => console.warn("Could not end Matrix call:", error));
    }
    if (dismissing) return Promise.resolve();
    const closing = closeMedia(session).catch(console.warn).finally(() => {
      if (stopping.current === closing) stopping.current = null;
    });
    stopping.current = closing;
    return closing;
  }, [update]);

  const fail = useCallback((session: Session, error: unknown) => {
    if (active.current !== session) return;
    void finish(true, "unknown_error");
    setError(String(error));
  }, [finish, setError]);

  const connectionDeadline = useCallback((session: Session) => {
    clearTimeout(session.deadline);
    session.deadline = setTimeout(() => {
      if (active.current !== session) return;
      void finish(true, session.call.established ? "ice_timeout" : "ice_failed");
      setError("The Matrix call connection timed out.");
    }, CONNECTION_TIMEOUT);
  }, [finish, setError]);

  const flushIce = useCallback((session: Session) => {
    if (!session.published || session.localCandidates.length === 0) return;
    const complete = session.localCandidates[session.localCandidates.length - 1].candidate === "";
    if (session.iceTimer && !complete) return;
    clearTimeout(session.iceTimer);
    session.iceTimer = setTimeout(() => {
      session.iceTimer = undefined;
      if (active.current !== session) return;
      const candidates = session.localCandidates.splice(0);
      session.iceSending = (session.iceSending ?? Promise.resolve()).then(async () => {
        if (active.current === session) await signal(session, "m.call.candidates", { candidates });
      }).catch((error) => fail(session, error));
    }, complete ? 0 : ICE_BATCH_DELAY);
  }, [fail]);

  const enableMedia = useCallback(async (session: Session, description?: Description) => {
    const party = session.remoteParty ?? "";
    const candidates = session.remoteCandidates.get(party) ?? [];
    session.remoteCandidates.clear();
    await invoke("update_matrix_voip_media", {
      callId: session.call.callId, description, candidates, startAudio: true,
      ...getStoredAudioDevicePreferences(),
    });
    session.remoteReady = true;
    // ICE arriving while the offer or answer was being applied is still queued.
    const waiting = session.remoteCandidates.get(party);
    session.remoteCandidates.clear();
    if (waiting?.length && active.current === session) {
      await invoke("update_matrix_voip_media", { callId: session.call.callId, candidates: waiting });
    }
  }, []);

  const answer = useCallback((onStarted?: (roomId: string) => void) => {
    const session = active.current;
    if (!session || session.call.phase !== "incoming" || session.call.expiresAt <= Date.now() || voiceBusy.current) return;
    setPhase(session, "answering", Date.now() + CONNECTION_TIMEOUT);
    onStarted?.(session.call.roomId);
    connectionDeadline(session);
    void (async () => {
      await requestMicrophonePermission();
      if (active.current !== session) return;
      const answer = await openMedia(session);
      if (active.current !== session) { await closeMedia(session); return; }
      await enableMedia(session);
      if (active.current !== session) return;
      session.publication = signal(session, "m.call.answer", { answer });
      await session.publication;
      session.published = true;
      flushIce(session);
    })().catch((error) => fail(session, error));
  }, [connectionDeadline, enableMedia, fail, flushIce, setPhase, voiceBusy]);

  const start = useCallback((call: DirectCall) => {
    const session = newSession(call, call.callId, 1);
    active.current = session;
    setMicEnabled(true);
    setConnection("connecting");
    setPhase(session, "dialing", Date.now() + INVITE_LIFETIME);
    void (async () => {
      if (stopping.current) await stopping.current;
      if (active.current !== session) return;
      await requestMicrophonePermission();
      if (active.current !== session) return;
      const offer = await openMedia(session);
      if (active.current !== session) { await closeMedia(session); return; }
      session.publication = signal(session, "m.call.invite", { offer, lifetime: INVITE_LIFETIME });
      await session.publication;
      if (active.current !== session) return;
      session.published = true;
      flushIce(session);
      if (session.call.phase === "dialing") {
        setPhase(session, "dialing", Date.now() + INVITE_LIFETIME);
        session.deadline = setTimeout(() => {
          if (active.current !== session || session.call.phase !== "dialing") return;
          void finish(true, "invite_timeout");
          setError("No answer.");
        }, INVITE_LIFETIME);
      }
    })().catch((error) => fail(session, error));
  }, [fail, finish, flushIce, setError, setPhase]);

  const receive = useCallback(async (event: WireSignal) => {
    const { content, kind } = event;
    const version = content.version === 0 ? 0 : 1;
    const party = version === 0 ? "" : content.party_id;
    if (typeof party !== "string" || (version === 1 && (!party || party.length > 255))) return;
    let session = active.current;
    if (kind === "m.call.invite") {
      const expiresAt = event.expiresAt;
      if (!event.fromPeer || voiceBusy.current || expiresAt <= Date.now() + 1_000
          || !validDescription(content.offer) || content.offer.type !== "offer") return;
      if (!event.silent) { dismissQuiet.current(); session = active.current; }
      // On crossed calls in one room, keep the lesser id on both clients.
      const preparing = current.current?.transport === "selecting"
        && current.current.roomId === event.roomId && current.current.peerUserId === event.sender;
      const crossed = session?.call.phase === "dialing" && session.call.roomId === event.roomId
        && session.call.peerUserId === event.sender && (!session.publication || session.wireId > content.call_id);
      if (current.current && !crossed && !preparing) return;
      if (crossed) await finish(true);
      else if (stopping.current) return;
      if ((current.current && !preparing) || voiceBusy.current) return;
      const call: DirectCall = {
        callId: event.notificationId, roomId: event.roomId, peerUserId: event.sender,
        peerDeviceId: party || undefined, ringEventId: event.eventId, transport: "matrix",
        phase: "incoming", silent: event.silent, expiresAt,
      };
      session = newSession(call, content.call_id, version, content.offer, party);
      active.current = session;
      setMicEnabled(true);
      setConnection("connecting");
      setError(null);
      update(call);
      if (crossed || preparing) answer();
      return;
    }
    if (!session || session.wireId !== content.call_id || session.call.roomId !== event.roomId) return;
    if (event.fromPeer && event.sender !== session.call.peerUserId) return;

    if (!event.fromPeer) {
      if (session.call.phase === "incoming" && (kind === "m.call.answer" || kind === "m.call.reject"
          || (kind === "m.call.hangup" && version === 0))) {
        void finish(false);
      }
      return;
    }
    if (session.remoteParty !== undefined && session.remoteParty !== party) return;

    switch (kind) {
      case "m.call.candidates": {
        const candidates = candidatesFrom(content.candidates);
        if (!candidates.length) break;
        if (session.remoteReady) {
          await invoke("update_matrix_voip_media", { callId: session.call.callId, candidates });
        } else if (session.remoteCandidates.has(party) || session.remoteCandidates.size < 16) {
          const buffer = session.remoteCandidates.get(party) ?? [];
          session.remoteCandidates.set(party, buffer.concat(candidates).slice(0, 128));
        }
        break;
      }
      case "m.call.answer": {
        if (session.fromInvite || session.call.phase !== "dialing" || !validDescription(content.answer)
            || content.answer.type !== "answer") break;
        session.remoteParty = party;
        setPhase(session, "connecting", Date.now() + CONNECTION_TIMEOUT);
        connectionDeadline(session);
        await enableMedia(session, content.answer);
        if (active.current !== session) return;
        if (version === 1) {
          void signal(session, "m.call.select_answer", { selected_party_id: party }).catch((error) => fail(session, error));
        }
        break;
      }
      case "m.call.select_answer":
        if (session.fromInvite && (content.selected_party_id !== event.localParty || session.call.phase === "incoming")) {
          void finish(false);
        }
        break;
      case "m.call.reject":
        if (!session.fromInvite && session.call.phase === "dialing") {
          void signal(session, "m.call.select_answer", { selected_party_id: party }).catch(console.warn);
          void finish(false);
          setError("Call declined.");
        }
        break;
      case "m.call.hangup":
        void finish(false);
        if (session.call.phase === "dialing") setError("Call ended before it was answered.");
        break;
      case "m.call.negotiate": {
        if (!session.remoteReady || !validDescription(content.description)) break;
        const reply = await invoke<Description | null>("update_matrix_voip_media", {
          callId: session.call.callId, description: content.description, renegotiate: true,
        });
        if (reply && active.current === session) {
          await signal(session, "m.call.negotiate", { description: reply, lifetime: INVITE_LIFETIME });
        }
        break;
      }
    }
  }, [answer, connectionDeadline, current, dismissQuiet, enableMedia, finish, setError, setPhase, update, voiceBusy]);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let reading = false;
    let needsRead = false;
    const subscriptions: UnlistenFn[] = [];
    async function drain() {
      needsRead = true;
      if (disposed || reading) return;
      reading = true;
      try {
        while (needsRead && !disposed) {
          needsRead = false;
          const signals = await invoke<WireSignal[]>("take_matrix_voip_signals");
          for (const event of signals) {
            if (disposed) return;
            if (seen.current.has(event.eventId)) continue;
            seen.current.add(event.eventId);
            if (seen.current.size > 512) seen.current.delete(seen.current.values().next().value!);
            try {
              await receive(event);
            } catch (error) {
              const session = active.current;
              if (session?.call.roomId === event.roomId && session.wireId === event.content.call_id) fail(session, error);
            }
          }
        }
      } catch (error) {
        if (!disposed) console.warn("Could not read Matrix call signals:", error);
      } finally {
        reading = false;
      }
    }
    const subscribe = (registration: Promise<UnlistenFn>) => registration
      .then((remove) => { if (disposed) remove(); else subscriptions.push(remove); });
    void Promise.all([
      subscribe(listen("matrix-voip-signals", drain)),
      subscribe(listen<{ callId: string; candidate: Candidate }>("matrix-voip-ice", ({ payload }) => {
        const session = active.current;
        if (session?.call.callId !== payload.callId) return;
        session.localCandidates.push(payload.candidate);
        flushIce(session);
      })),
      subscribe(listen<{ callId: string; status: string }>("matrix-voip-status", ({ payload }) => {
        const session = active.current;
        if (session?.call.callId !== payload.callId) return;
        if (payload.status === "connected") {
          clearTimeout(session.deadline);
          setConnection("connected");
          setPhase(session, "active");
        } else if (payload.status === "failed") {
          void finish(true, session.call.established ? "ice_timeout" : "ice_failed");
          setError("The Matrix call connection failed.");
        } else if (payload.status === "left") {
          void finish(false);
          setError("The other participant left the room.");
        } else {
          setConnection("interrupted");
          connectionDeadline(session);
        }
      })),
    ]).then(drain).catch((error) => console.warn("Could not listen for Matrix calls:", error));
    return () => { disposed = true; subscriptions.forEach((remove) => remove()); };
  }, [connectionDeadline, fail, finish, flushIce, ready, receive, setError, setPhase]);

  useEffect(() => () => {
    const session = active.current;
    if (!session) return;
    active.current = null;
    clearTimeout(session.deadline);
    clearTimeout(session.iceTimer);
    void closeMedia(session).catch(console.warn);
  }, []);

  const toggleMic = useCallback(() => {
    const session = active.current;
    if (!session) return;
    void invoke<boolean>("toggle_matrix_voip_mic", { callId: session.call.callId })
      .then((enabled) => { if (active.current === session) setMicEnabled(enabled); })
      .catch((reason) => setError(String(reason)));
  }, [setError]);

  const silence = useCallback((silent: boolean) => {
    const session = active.current;
    if (session?.call.phase !== "incoming") return;
    session.call = { ...session.call, silent };
    update(session.call);
  }, [update]);

  return { start, answer, finish, toggleMic, micEnabled, connection, silence };
}
