/**
 * Client entry point of the Ling Gao 校对员 plugin (Task 17; design §9.1/§9.6).
 *
 * The DSH client module loader executes this file once at materialization; the
 * exported {@link apply} registers:
 * 1. the `lgproofreader` locale dictionaries (zh + en) through `ctx.locale`;
 * 2. the workbench page in the layout's `main` keyed slot under key
 *    `lgproofreader` (the same key the sidebar row selects);
 * 3. the sidebar entry in `sidebar.panellist` with id `lgproofreader`, order 20
 *    (after shipped `plugins` 0 / `schedules` 10) and the locale-bound label.
 *
 * Both registrations are deferred with `ctx.slots.inject(slot, …)` so they wait
 * for the owning shell entries (layout/sidebar) to declare their slots. DSH
 * disposes both through the caller's Cordis effect on unload, and the injected
 * `<style>` in `App` is removed with the component — nothing is written to
 * `document.head`, no app root is replaced and no iframe is created.
 *
 * The module declares the structural subset of the client Cordis context it
 * uses (like the Host entry's structural `PluginContext`), so the client half
 * keeps zero `@deepseek-ai/*` imports and the whole panel stays a plain ESM
 * module that the build (Task 20) wraps in the DSH `__ModuleLoader__` factory.
 */
import type { ComponentType } from 'react'
import { App } from './app'
import { sidebarIcon } from './assets'
import { NS, en, zh } from './locale'

/* ------------------------------------------------------------------------- */
/* Structural Cordis client contract                                         */
/* ------------------------------------------------------------------------- */

/** Options accepted by the slot registry's `register` (the subset we use). */
export interface SlotRegisterOptions {
  /** Target slot key, e.g. `main` or `sidebar.panellist`. */
  name: string
  /** Keyed-slot cell key (the sidebar row's id also addresses the main panel). */
  key?: string
  /** List-slot cell id. */
  id?: string
  /** List-slot ascending order. */
  order?: number
  /** Display label; a thunk is re-read on every projection (locale switch). */
  label?: string | (() => string)
  /** Locale namespace bound to the `t` seat handed to the component. */
  locale?: string
}

/** The slot registry members this entry consumes (`ctx.slots`). */
export interface SlotService {
  /** Defer a registration until the target slot is declared. */
  inject(name: string, register: () => unknown): unknown
  /** Register one occupant; disposal is owned by the caller's context. */
  register(options: SlotRegisterOptions, component: ComponentType<any>): unknown
}

/** The locale service members this entry consumes (`ctx.locale`). */
export interface LocaleService {
  /** Register the zh + en dictionaries for one namespace. */
  register(
    namespace: string,
    dictionaries: { zh: Record<string, string>; en: Record<string, string> },
  ): () => void
  /** Bind a namespace to a stable translate function (reads at call time). */
  bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
}

/** Structural subset of the DSH client plugin context. */
export interface ClientContext {
  /** Run `callback` now and dispose its return value with the plugin lifetime. */
  effect(callback: () => (() => void) | void, label?: string): () => void
  slots: SlotService
  locale: LocaleService
}

/* ------------------------------------------------------------------------- */
/* Sidebar icon                                                               */
/* ------------------------------------------------------------------------- */

/** Resolved sidebar cell size (owner passes 16px wide / 18px collapsed). */
const DEFAULT_PANEL_ICON_SIZE = 18

/** Props supplied by the sidebar to one global-panel icon occupant. */
export interface PanelIconProps {
  /** Requested square edge in pixels. */
  size?: number
  /** Whether this panel is selected in the main column. */
  active?: boolean
}

/**
 * Compact sidebar icon for the plugin's global panel row.
 *
 * The sidebar row itself owns the accessible name (it resolves it from the
 * registered `label`), so the decorative image is hidden from assistive tech.
 */
export function PanelIcon({ size = DEFAULT_PANEL_ICON_SIZE, active = false }: PanelIconProps) {
  return (
    <span
      className="lgp-panel-icon"
      data-lgp-part="panel-icon"
      data-active={active ? 'true' : undefined}
    >
      <img src={sidebarIcon} alt="" aria-hidden="true" width={size} height={size} draggable={false} />
    </span>
  )
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                */
/* ------------------------------------------------------------------------- */

/** Services required before this client half activates. */
export const inject: string[] = ['slots', 'locale']

/** Stable main-panel key; matches the `sidebar.panellist` id. */
export const MAIN_KEY = 'lgproofreader'

/** Sidebar row order: after shipped `plugins` (0) and `schedules` (10). */
export const PANEL_ORDER = 20

/**
 * Activate the client half: register dictionaries, the main workbench page and
 * the sidebar panel entry.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'lg-proofreader: locale dictionaries',
  )

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: MAIN_KEY, locale: NS }, App),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: MAIN_KEY,
        order: PANEL_ORDER,
        label: () => t('panel'),
      },
      PanelIcon,
    ),
  )
}
