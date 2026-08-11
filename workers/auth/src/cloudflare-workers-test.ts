/** Node-only Vitest shim. Workerd supplies the real class in production. */
export class WorkerEntrypoint<Env = unknown> {
  protected env!: Env;
}
