export namespace Rpc {
  type Definition = {
    [method: string]: (input: any) => any
  }

  interface SerializedError {
    name: string
    message: string
    stack?: string
    data?: Record<string, unknown>
  }

  function serializeError(err: unknown): SerializedError {
    if (err instanceof Error) {
      const serialized: SerializedError = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      }
      if ("toObject" in err && typeof err.toObject === "function") {
        serialized.data = err.toObject().data
      }
      return serialized
    }
    return {
      name: "Error",
      message: String(err),
    }
  }

  export function listen(rpc: Definition) {
    onmessage = async (evt) => {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.request") {
        try {
          const result = await rpc[parsed.method](parsed.input)
          postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
        } catch (err) {
          postMessage(JSON.stringify({ type: "rpc.error", error: serializeError(err), id: parsed.id }))
        }
      }
    }
  }

  export function emit(event: string, data: unknown) {
    postMessage(JSON.stringify({ type: "rpc.event", event, data }))
  }

  /**
   * Error class that reconstructs a remote error in a way that is compatible
   * with NamedError.isInstance checks. The `name` and `data` properties match
   * the original error, allowing FormatError to handle it correctly.
   */
  export class RemoteError extends Error {
    readonly data?: Record<string, unknown>

    constructor(error: SerializedError) {
      super(error.message)
      this.name = error.name
      this.stack = error.stack
      this.data = error.data
    }
  }

  export function client<T extends Definition>(target: {
    postMessage: (data: string) => void | null
    onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  }) {
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
    const listeners = new Map<string, Set<(data: any) => void>>()
    let id = 0
    target.onmessage = async (evt) => {
      const parsed = JSON.parse(evt.data)
      if (parsed.type === "rpc.result") {
        const handler = pending.get(parsed.id)
        if (handler) {
          handler.resolve(parsed.result)
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.error") {
        const handler = pending.get(parsed.id)
        if (handler) {
          handler.reject(new RemoteError(parsed.error))
          pending.delete(parsed.id)
        }
      }
      if (parsed.type === "rpc.event") {
        const handlers = listeners.get(parsed.event)
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed.data)
          }
        }
      }
    }
    return {
      call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
        const requestId = id++
        return new Promise((resolve, reject) => {
          pending.set(requestId, { resolve, reject })
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        })
      },
      on<Data>(event: string, handler: (data: Data) => void) {
        let handlers = listeners.get(event)
        if (!handlers) {
          handlers = new Set()
          listeners.set(event, handlers)
        }
        handlers.add(handler)
        return () => {
          handlers!.delete(handler)
        }
      },
    }
  }
}
