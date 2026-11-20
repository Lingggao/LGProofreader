/**
 * Exact `connection.fetch` route table for the Ling Gao 校对员 plugin Host API
 * (Task 15; design §10.2).
 *
 * `ctx.connection.fetch.register()` accepts only **exact** paths under `/api`
 * (no `:id` dynamic segments; ids travel in the query string or JSON body) and
 * GET/HEAD/POST only. The connection service keys its registry by path and
 * refuses a second route object for one path (verified in the installed
 * `0.2.2-rc.5` `dsh-client-connection` source:
 * `client-connection/src/rpc-host.ts` → `registerFetchRoute` throws
 * `already registered`). The design table has two methods on `/page-image`
 * (GET reads the stored page image, POST uploads it), so {@link createRoutes}
 * groups rows by path and merges their methods into **one** route whose `fetch`
 * dispatches by request method. Every other route maps one-to-one to a handler
 * function, unchanged.
 *
 * {@link ROUTE_TABLE} is the single Host-side declaration of the 17 documented
 * handler routes; paths come from the shared protocol
 * (`src/shared/api/protocol.ts`), so a handler cannot be registered on a path
 * the Client does not call.
 *
 * Host-only module; no Node.js, DSH or npm imports beyond the shared protocol.
 */
import { API_PATHS, type HandlerName, type PluginHandlers } from '../../shared/api/protocol'
import { PLUGIN_ID } from '../config'

/* ------------------------------------------------------------------------- */
/* Contract                                                                    */
/* ------------------------------------------------------------------------- */

/** HTTP methods accepted by exact Fetch routes (`ConnectionFetchMethod`). */
export type RouteMethod = 'GET' | 'HEAD' | 'POST'

/** How the carrier presents the request body (`ConnectionRequestBodyMode`). */
export type RouteRequestBodyMode = 'buffered' | 'streaming'

/** One documented handler route (design §10.2). */
export interface RouteTableEntry {
  /** Handler in {@link PluginHandlers} this row dispatches to. */
  readonly name: HandlerName
  /** Exact absolute path below `/api`. */
  readonly path: string
  /** Methods this handler answers (only `/page-image` intentionally has two rows). */
  readonly methods: readonly RouteMethod[]
  /** `streaming` for the PDF upload; `buffered` for every other route. */
  readonly requestBody: RouteRequestBodyMode
}

/**
 * Structural mirror of the installed DSH `ConnectionFetchRoute`; the Host entry
 * has zero `@deepseek-ai/*` type dependencies.
 */
export interface ConnectionFetchRoute {
  readonly path: string
  readonly methods: readonly RouteMethod[]
  readonly requestBody: RouteRequestBodyMode
  readonly fetch: (request: Request) => Promise<Response>
}

/** Structural mirror of the installed DSH `HostConnectionFetch`. */
export interface ConnectionFetchRegistry {
  register(route: ConnectionFetchRoute): () => Promise<void>
}

/** The slice of `ctx` route registration needs (Cordis `effect` + Connection). */
export interface RouteRegistrationContext {
  effect(execute: () => () => void | Promise<void>, label?: string): unknown
  connection: { fetch: ConnectionFetchRegistry }
}

/** Effect label shown in Cordis effect diagnostics. */
export const ROUTES_EFFECT_LABEL = `${PLUGIN_ID}: Host API routes`

/** One handler function. */
type Handler = PluginHandlers[HandlerName]

/* ------------------------------------------------------------------------- */
/* Route table                                                                 */
/* ------------------------------------------------------------------------- */

function route(
  name: HandlerName,
  methods: readonly RouteMethod[],
  requestBody: RouteRequestBodyMode = 'buffered',
): RouteTableEntry {
  return Object.freeze({ name, path: API_PATHS[name], methods: Object.freeze([...methods]), requestBody })
}

/**
 * All 17 exact method/path rows of design §10.2, in table order.
 *
 * `/page-image` (POST upload + GET read) and `/settings` (GET read + POST save)
 * appear twice on purpose; the route builder merges each pair into one transport
 * route because Connection allows only one route object per path.
 */
export const ROUTE_TABLE: readonly RouteTableEntry[] = Object.freeze([
  route('uploadDocument', ['POST'], 'streaming'),
  route('pageText', ['POST']),
  route('pageImage', ['POST']),
  route('pageOverlay', ['POST']),
  route('analyze', ['POST']),
  route('document', ['GET']),
  route('layout', ['POST']),
  route('pageImageGet', ['GET']),
  route('proofread', ['POST']),
  route('job', ['GET']),
  route('cancel', ['POST']),
  route('deleteDoc', ['POST']),
  route('meta', ['GET']),
  route('settingsGet', ['GET']),
  route('settingsPost', ['POST']),
  route('exportReport', ['GET']),
  route('health', ['GET']),
])

/* ------------------------------------------------------------------------- */
/* Route creation                                                              */
/* ------------------------------------------------------------------------- */

/** Per-path accumulator used while grouping the table. */
interface RouteGroup {
  readonly path: string
  readonly methods: RouteMethod[]
  readonly handlersByMethod: Map<RouteMethod, Handler>
  requestBody: RouteRequestBodyMode
}

/**
 * Build the routes registered with `ctx.connection.fetch.register()`.
 *
 * A path reached by exactly one handler keeps that handler function as `fetch`
 * (identity preserved). A path reached by several methods (`/page-image` and
 * `/settings`) becomes one route owning all of them, and its `fetch` dispatches
 * on `request.method`; an unexpected method answers `405` instead of silently
 * calling the wrong handler.
 *
 * @throws {TypeError} when a handler is missing or not a function.
 * @throws {Error} when the table repeats a method on one path or assigns one
 *   path two different `requestBody` modes — a programming error in the table.
 */
export function createRoutes(handlers: PluginHandlers): ConnectionFetchRoute[] {
  const groups = new Map<string, RouteGroup>()

  for (const entry of ROUTE_TABLE) {
    const handler = handlers[entry.name]
    if (typeof handler !== 'function') {
      throw new TypeError(`createRoutes() is missing the ${entry.name} handler`)
    }

    let group = groups.get(entry.path)
    if (group === undefined) {
      group = {
        path: entry.path,
        methods: [],
        handlersByMethod: new Map<RouteMethod, Handler>(),
        requestBody: entry.requestBody,
      }
      groups.set(entry.path, group)
    } else if (group.requestBody !== entry.requestBody) {
      throw new Error(
        `route table assigns conflicting requestBody modes to ${entry.path}`,
      )
    }

    for (const method of entry.methods) {
      if (group.handlersByMethod.has(method)) {
        throw new Error(`route table repeats ${method} ${entry.path}`)
      }
      group.handlersByMethod.set(method, handler)
      group.methods.push(method)
    }
  }

  const routes: ConnectionFetchRoute[] = []
  for (const group of groups.values()) {
    routes.push({
      path: group.path,
      methods: Object.freeze([...group.methods]),
      requestBody: group.requestBody,
      fetch:
        group.methods.length === 1
          ? (group.handlersByMethod.values().next().value as Handler)
          : (request: Request) => dispatchByMethod(group, request),
    })
  }
  return routes
}

/** Dispatch one request on a path that several methods share. */
function dispatchByMethod(group: RouteGroup, request: Request): Promise<Response> {
  const handler = group.handlersByMethod.get(request.method as RouteMethod)
  if (handler === undefined) {
    // The carrier only dispatches declared methods; direct callers get an
    // explicit refusal instead of another handler's response.
    return Promise.resolve(new Response('method not allowed', { status: 405 }))
  }
  return handler(request)
}

/* ------------------------------------------------------------------------- */
/* Registration                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Register the whole Host API with one owned Cordis effect.
 *
 * The effect body registers every route through
 * `ctx.connection.fetch.register()` and returns their combined disposer, so
 * unloading the plugin removes all routes. When a registration fails midway, the
 * routes registered before the failure are disposed immediately and the error is
 * rethrown, leaving no partial API surface behind.
 */
export function registerRoutes(
  ctx: RouteRegistrationContext,
  handlers: PluginHandlers,
): void {
  ctx.effect(() => {
    const disposers: (() => Promise<void>)[] = []
    try {
      for (const route of createRoutes(handlers)) {
        disposers.push(ctx.connection.fetch.register(route))
      }
    } catch (error) {
      // Best-effort rollback: invoking each disposer starts synchronously, and a
      // failing disposer must not mask the registration error.
      void disposeRoutes(disposers)
      throw error
    }
    return () => disposeRoutes(disposers)
  }, ROUTES_EFFECT_LABEL)
}

/** Run every route disposer; a single failing disposer never rejects the cleanup. */
async function disposeRoutes(disposers: readonly (() => Promise<void>)[]): Promise<void> {
  await Promise.all(
    disposers.map(async (dispose) => {
      try {
        await dispose()
      } catch {
        // Unloading is best-effort: one broken route must not keep the others mounted.
      }
    }),
  )
}
