import type { LivekitVoiceParticipantInfo, LivekitVoiceSnapshot, VoiceMembershipSnapshot, VoiceParticipant } from "../types/matrix.ts";
import { compareByDisplayThenKey } from "../utils/matrix.ts";

type MatrixMap = Record<string, VoiceParticipant[]>;
type LivekitMap = Record<string, LivekitVoiceParticipantInfo[]>;
export type VoicePresenceSnapshot = { participantsByRoom: MatrixMap; livekitByRoom: LivekitMap };
type Options = {
  loadMatrix: (roomIds?: string[]) => Promise<VoiceMembershipSnapshot>;
  loadLivekit: (roomIds: string[]) => Promise<LivekitVoiceSnapshot>;
  onParticipants?: (participants: VoiceParticipant[]) => void;
  pollMs?: number;
  retryMs?: number;
};

function stableRows<T>(old: T[] | undefined, incoming: T[], key: (row: T) => string, equal: (a: T, b: T) => boolean, sort: (a: T, b: T) => number): T[] {
  const previous = new Map(old?.map((row) => [key(row), row]));
  const rows = [...new Map(incoming.map((row) => [key(row), row])).values()].map((row) => {
    const cached = previous.get(key(row));
    return cached && equal(cached, row) ? cached : row;
  }).sort(sort);
  return old && rows.length === old.length && rows.every((row, i) => row === old[i]) ? old : rows;
}

const sameMatrix = (a: VoiceParticipant, b: VoiceParticipant) => a.userId === b.userId && a.displayName === b.displayName && a.avatarUrl === b.avatarUrl;
const sameLivekit = (a: LivekitVoiceParticipantInfo, b: LivekitVoiceParticipantInfo) => a.identity === b.identity && a.isMuted === b.isMuted && a.isDeafened === b.isDeafened && a.isSpeaking === b.isSpeaking;
const sameMap = <T>(a: Record<string, T>, b: Record<string, T>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((id) => a[id] === b[id]);

/** One session owner for membership and activity snapshots. Each source has
 * one request in flight, so a slow SFU cannot hold up local Matrix changes. */
export class VoicePresenceStore {
  private options: Options;
  private snapshot: VoicePresenceSnapshot = { participantsByRoom: {}, livekitByRoom: {} };
  private listeners = new Set<() => void>();
  private active = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private matrixFlight = false;
  private livekitFlight = false;
  private allRevision = 0;
  private fullDue: number | null = 0;
  private fullFailures = 0;
  private matrixDue = new Map<string, number>();
  private matrixRevision = new Map<string, number>();
  private matrixFailures = new Map<string, number>();
  private livekitDue = new Map<string, number>();
  private livekitRevision = new Map<string, number>();
  private livekitFailures = new Map<string, number>();
  private scopes = new Map<symbol, Set<string>>();
  private demanded = new Set<string>();
  private joined: Set<string> | null = null;
  private connectedRoom: string | null = null;
  private livekitAvailable = true;

  constructor(options: Options) { this.options = options; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(matrix: MatrixMap, livekit = this.snapshot.livekitByRoom) {
    const sameMemberships = sameMap(matrix, this.snapshot.participantsByRoom);
    const sameActivity = sameMap(livekit, this.snapshot.livekitByRoom);
    if (sameMemberships && sameActivity) return;
    this.snapshot = {
      participantsByRoom: sameMemberships ? this.snapshot.participantsByRoom : matrix,
      livekitByRoom: sameActivity ? this.snapshot.livekitByRoom : livekit,
    };
    for (const listener of this.listeners) listener();
  }

  start() {
    this.active = true;
    this.invalidateMatrix();
    this.invalidateLivekit([...this.demanded]);
  }
  dispose() {
    this.active = false;
    this.epoch++;
    this.matrixFlight = this.livekitFlight = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  invalidateMatrix(roomIds?: string[]) {
    if (!roomIds) { this.allRevision++; this.fullDue = 0; }
    else for (const id of new Set(roomIds)) {
      this.matrixRevision.set(id, (this.matrixRevision.get(id) ?? 0) + 1);
      this.matrixDue.set(id, 0);
    }
    this.schedule();
  }

  invalidateLivekit(roomIds: string[]) {
    for (const id of new Set(roomIds)) if (this.demanded.has(id)) {
      this.livekitRevision.set(id, (this.livekitRevision.get(id) ?? 0) + 1);
      this.livekitDue.set(id, 0);
    }
    this.schedule();
  }

  setConnectedRoom(roomId: string | null) {
    if (roomId === this.connectedRoom) return;
    const changed = [this.connectedRoom, roomId].filter((id): id is string => id !== null);
    this.connectedRoom = roomId;
    this.invalidateMatrix(changed);
    this.invalidateLivekit(changed);
  }

  watchLivekit(roomIds: string[]): () => void {
    const token = Symbol();
    this.scopes.set(token, new Set(roomIds));
    this.updateDemand();
    return () => { this.scopes.delete(token); this.updateDemand(); };
  }

  private updateDemand() {
    const next = new Set([...this.scopes.values()].flatMap((ids) => [...ids]));
    for (const id of next) if (!this.demanded.has(id)) {
      this.livekitRevision.set(id, (this.livekitRevision.get(id) ?? 0) + 1);
      this.livekitDue.set(id, 0);
    }
    for (const id of this.demanded) if (!next.has(id)) {
      this.livekitRevision.set(id, (this.livekitRevision.get(id) ?? 0) + 1);
      this.livekitDue.delete(id);
      this.livekitFailures.delete(id);
    }
    this.demanded = next;
    this.schedule();
  }

  private retry(failures: number) { return Math.min((this.options.retryMs ?? 1000) * 2 ** Math.min(failures - 1, 5), 30_000); }

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.active) return;
    const matrix = this.matrixFlight ? Infinity : Math.min(this.fullDue ?? Infinity, ...this.matrixDue.values());
    const livekit = this.livekitFlight || !this.livekitAvailable ? Infinity : Math.min(...[...this.livekitDue].filter(([id]) => id !== this.connectedRoom).map(([, due]) => due));
    const next = Math.min(matrix, livekit);
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      if (!this.matrixFlight) {
        if (this.fullDue !== null && this.fullDue <= now) void this.refreshMatrix();
        else {
          const ids = [...this.matrixDue].filter(([, due]) => due <= now).sort((a, b) => a[1] - b[1]).slice(0, 128).map(([id]) => id);
          if (ids.length) void this.refreshMatrix(ids);
        }
      }
      if (!this.livekitFlight && this.livekitAvailable) {
        const ids = [...this.livekitDue].filter(([id, due]) => id !== this.connectedRoom && due <= now).sort((a, b) => a[1] - b[1]).slice(0, 32).map(([id]) => id);
        if (ids.length) void this.refreshLivekit(ids);
      }
      this.schedule();
    }, Math.min(Math.max(0, next - Date.now()), 2_147_483_647));
  }

  private async refreshMatrix(ids?: string[]) {
    this.matrixFlight = true;
    const epoch = this.epoch, allRevision = this.allRevision;
    const revisions = new Map(this.matrixRevision);
    if (!ids) { this.fullDue = null; this.matrixDue.clear(); }
    else ids.forEach((id) => this.matrixDue.delete(id));
    try {
      const result = await this.options.loadMatrix(ids);
      if (!this.active || epoch !== this.epoch || allRevision !== this.allRevision) return;
      this.fullFailures = 0;
      const previouslyJoined = this.joined;
      this.joined = new Set(result.roomIds);
      if (previouslyJoined) this.invalidateLivekit(result.roomIds.filter((id) => !previouslyJoined.has(id)));
      const matrix = Object.fromEntries(Object.entries(this.snapshot.participantsByRoom).filter(([id]) => this.joined!.has(id)));
      const livekit = Object.fromEntries(Object.entries(this.snapshot.livekitByRoom).filter(([id]) => this.joined!.has(id)));
      for (const id of this.matrixDue.keys()) {
        if (!this.joined.has(id) && (revisions.get(id) ?? 0) === (this.matrixRevision.get(id) ?? 0)) this.matrixDue.delete(id);
      }
      for (const id of ids ?? result.roomIds) {
        if ((revisions.get(id) ?? 0) !== (this.matrixRevision.get(id) ?? 0) || !this.joined.has(id)) continue;
        const rows = result.participantsByRoom[id];
        if (rows === undefined) {
          const failures = (this.matrixFailures.get(id) ?? 0) + 1;
          this.matrixFailures.set(id, failures);
          this.matrixDue.set(id, Date.now() + this.retry(failures));
          continue;
        }
        this.matrixFailures.delete(id);
        matrix[id] = stableRows(matrix[id], rows, (p) => p.userId.toLowerCase(), sameMatrix,
          (a, b) => compareByDisplayThenKey(a.displayName ?? a.userId, a.userId, b.displayName ?? b.userId, b.userId));
        const expiry = result.expiresAtByRoom[id];
        if (expiry !== undefined) this.matrixDue.set(id, Math.max(Date.now() + 25, expiry));
        this.options.onParticipants?.(matrix[id]);
      }
      this.publish(matrix, livekit);
    } catch (error) {
      if (!this.active || epoch !== this.epoch || allRevision !== this.allRevision) return;
      if (!ids) this.fullDue = Date.now() + this.retry(++this.fullFailures);
      else for (const id of ids) if ((revisions.get(id) ?? 0) === (this.matrixRevision.get(id) ?? 0)) {
        const failures = (this.matrixFailures.get(id) ?? 0) + 1;
        this.matrixFailures.set(id, failures);
        this.matrixDue.set(id, Date.now() + this.retry(failures));
      }
      console.warn("Voice membership refresh failed:", error);
    } finally {
      if (epoch === this.epoch) { this.matrixFlight = false; this.schedule(); }
    }
  }

  private async refreshLivekit(ids: string[]) {
    this.livekitFlight = true;
    const epoch = this.epoch;
    const revisions = new Map(this.livekitRevision);
    ids.forEach((id) => this.livekitDue.delete(id));
    try {
      const result = await this.options.loadLivekit(ids);
      if (!this.active || epoch !== this.epoch) return;
      this.livekitAvailable = result.available;
      this.applyLivekit(ids, revisions, result.participantsByRoom);
    } catch (error) {
      if (this.active && epoch === this.epoch) {
        this.applyLivekit(ids, revisions, {});
        console.warn("LiveKit presence refresh failed:", error);
      }
    } finally {
      if (epoch === this.epoch) { this.livekitFlight = false; this.schedule(); }
    }
  }

  private applyLivekit(ids: string[], revisions: Map<string, number>, incoming: LivekitMap) {
    const livekit = { ...this.snapshot.livekitByRoom };
    for (const id of ids) {
      if (!this.demanded.has(id) || revisions.get(id) !== this.livekitRevision.get(id)) continue;
      if (this.joined && !this.joined.has(id)) { this.livekitDue.delete(id); continue; }
      const rows = incoming[id];
      if (rows === undefined) {
        const failures = (this.livekitFailures.get(id) ?? 0) + 1;
        this.livekitFailures.set(id, failures);
        this.livekitDue.set(id, Date.now() + this.retry(failures));
      } else {
        this.livekitFailures.delete(id);
        livekit[id] = stableRows(livekit[id], rows, (p) => p.identity, sameLivekit, (a, b) => a.identity.localeCompare(b.identity));
        this.livekitDue.set(id, Date.now() + (this.options.pollMs ?? 5000));
      }
    }
    this.publish(this.snapshot.participantsByRoom, livekit);
  }
}
