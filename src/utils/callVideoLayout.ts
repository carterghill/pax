export interface RemoteCallVideo {
  identity: string;
  streamId: string;
  source: "camera" | "screen";
}

export type CallStream =
  | RemoteCallVideo & { local?: false }
  | { identity: string; local: true; source: "camera"; media: MediaStream }
  | { identity: string; local: true; source: "screen" };

export function callVideoLayout(
  remote: RemoteCallVideo[], localIdentity: string, localCamera: MediaStream | null, sharingScreen: boolean,
) {
  const streams: CallStream[] = [...remote];
  if (localCamera) streams.push({ identity: localIdentity, local: true, source: "camera", media: localCamera });
  if (sharingScreen) streams.push({ identity: localIdentity, local: true, source: "screen" });

  const screenOwners = new Set(streams.filter((s) => s.source === "screen").map((s) => s.identity));
  const tiles: CallStream[] = [];
  const avatarCameras = new Map<string, CallStream>();
  for (const stream of streams) {
    if (stream.source === "camera" && screenOwners.has(stream.identity)) {
      avatarCameras.set(stream.identity, stream);
    } else {
      tiles.push(stream);
    }
  }
  return { tiles, avatarCameras };
}
