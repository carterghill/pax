import { AttachmentLease } from "../../data/AttachmentLease";
import { getMatrixImagePath, releaseMatrixMedia } from "./api";

export function acquireMatrixMedia(request: unknown): AttachmentLease {
  return new AttachmentLease(crypto.randomUUID(), request, {
    acquire: getMatrixImagePath,
    release: releaseMatrixMedia,
  });
}
