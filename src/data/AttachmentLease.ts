type Transport = {
  acquire: (request: unknown, leaseId: string) => Promise<string>;
  release: (leaseId: string) => Promise<unknown>;
};

/** Keep a backend attachment pinned while its consumer is mounted. Cleanup
 * waits for acquisition to settle, so release cannot overtake acquisition
 * across IPC or leak a lease when a slow request finishes after unmount. */
export class AttachmentLease {
  readonly path: Promise<string>;
  private disposed = false;
  private started = false;
  private settled = false;
  private releasing = false;
  private id: string;
  private transport: Transport;

  constructor(id: string, request: unknown, transport: Transport) {
    this.id = id;
    this.transport = transport;
    this.path = Promise.resolve().then(() => {
      if (this.disposed) throw new Error("Attachment request cancelled");
      this.started = true;
      return transport.acquire(request, id);
    }).then((path) => {
      this.settled = true;
      if (this.disposed) this.release();
      return path;
    }, (error) => {
      this.settled = true;
      this.dispose();
      throw error;
    });
  }

  dispose() {
    this.disposed = true;
    if (this.settled) this.release();
  }

  private release() {
    if (!this.started || this.releasing) return;
    this.releasing = true;
    void Promise.resolve().then(() => this.transport.release(this.id)).catch((error) => {
      console.warn("Failed to release attachment:", error);
    });
  }
}
