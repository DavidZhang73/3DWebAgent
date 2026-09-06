import { errorCode } from './runtime.ts';
import type { World } from './runtime.ts';
import { LIFECYCLE_TOOLS } from './types.ts';
import type { Input } from './types.ts';
import { DEFINITIONS } from './capabilities.ts';
type Registered = { name: string; description?: string; inputSchema?: unknown };
type Context = {
  registerTool: (tool: unknown, options: { signal: AbortSignal }) => void | Promise<void>;
  getTools?: () => Promise<Registered[]>;
  unregisterTool?: (name: string) => void;
};
export type Diagnostics = {
  api: boolean;
  status: string;
  registered: string[];
  native: string[];
  calls: { time: string; name: string; status: string }[];
};
export const diagnostics: Diagnostics = {
  api: false,
  status: 'Not initialized',
  registered: [],
  native: [],
  calls: [],
};
let queue: Promise<unknown> = Promise.resolve(),
  disposeActive = () => {},
  generation = 0;
export function registerTools(world: World, changed: () => void) {
  let cancelled = false,
    disposeLocal = () => {};
  const run = queue
    .catch(() => {})
    .then(async () => {
      if (cancelled) return;
      disposeActive();
      const mine = ++generation,
        controller = new AbortController(),
        registered: string[] = [];
      const context =
        (document as Document & { modelContext?: Context }).modelContext ??
        (navigator as Navigator & { modelContext?: Context }).modelContext;
      diagnostics.api = !!context;
      diagnostics.registered = [];
      diagnostics.native = [];
      const dispose = () => {
        controller.abort();
        registered.forEach((n) => context?.unregisterTool?.(n));
      };
      disposeActive = dispose;
      disposeLocal = dispose;
      if (!context) {
        diagnostics.status = 'Browser API unavailable. Enable WebMCP for testing and restart.';
        changed();
        return;
      }
      diagnostics.status = 'Registering';
      changed();
      try {
        for (const name of [...new Set([...world.config.enabledTools, ...LIFECYCLE_TOOLS])]) {
          if (cancelled) {
            dispose();
            return;
          }
          const d = DEFINITIONS[name];
          await context.registerTool(
            {
              name,
              description: d.description,
              inputSchema: d.inputSchema,
              annotations: { readOnlyHint: d.readOnly },
              execute: async (input: Input, ctx?: { signal?: AbortSignal }) => {
                const callIndex = world.episode.calls?.length ?? 0;
                try {
                  if (controller.signal.aborted)
                    throw new Error('This tool registration has expired.');
                  const result = await world.execute(name, input, 'webmcp', ctx?.signal);
                  diagnostics.calls.unshift({
                    time: new Date().toLocaleTimeString(),
                    name,
                    status: 'completed',
                  });
                  diagnostics.calls.splice(50);
                  changed();
                  const wire = JSON.stringify(result, (_key, value) => {
                    if (value?.type === 'image' && value.observation) {
                      const bytes = world.episode.observations[value.observation];
                      let data = '';
                      for (const b of bytes) data += String.fromCharCode(b);
                      return { type: 'image', mimeType: 'image/png', data: btoa(data) };
                    }
                    return value;
                  });
                  const call = world.episode.calls
                    ?.slice()
                    .reverse()
                    .find((c) => c.name === name && c.result === result);
                  if (call) {
                    call.transport = wire;
                    world.episode.revision++;
                    world.refreshDirty();
                  }
                  return wire;
                } catch (e) {
                  const message = e instanceof Error ? e.message : String(e);
                  diagnostics.calls.unshift({
                    time: new Date().toLocaleTimeString(),
                    name,
                    status: message,
                  });
                  diagnostics.calls.splice(50);
                  changed();
                  const wire = JSON.stringify({ error: message, code: errorCode(message) });
                  const call = world.episode.calls?.[callIndex];
                  if (call && call.name === name && call.status === 'error') {
                    call.transport = wire;
                    world.episode.revision++;
                    world.refreshDirty();
                  }
                  return wire;
                }
              },
            },
            { signal: controller.signal },
          );
          registered.push(name);
        }
        if (cancelled || mine !== generation) {
          dispose();
          return;
        }
        diagnostics.registered = [...registered];
        if (context.getTools) diagnostics.native = (await context.getTools()).map((t) => t.name);
        diagnostics.status = 'WebMCP connected';
      } catch (e) {
        dispose();
        diagnostics.registered = [];
        diagnostics.status = String(e);
      }
      changed();
    });
  queue = run;
  return () => {
    cancelled = true;
    disposeLocal();
  };
}
