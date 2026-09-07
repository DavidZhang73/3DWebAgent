# 3DWebAgent

**An AI-agent-native 3D physics environment in your browser.**

Give your agent a URL. It can discover the world's tools, inspect objects,
perform actions, and observe the results while you watch in the same browser tab.

- **WebMCP** is the agent interface: structured tools for perception, manipulation,
  physics, and camera control, exposed directly by the page.
- **MuJoCo** simulates rigid-body dynamics and contacts through WebAssembly.
- **Three.js** renders the world and provides an interactive view for humans.

## Try it with your agent

Choose an assembly task and give its prompt to your agent. Each link opens an
initial episode with separate furniture parts; the matching manual is hosted
alongside it.

| Demo          | Parts | Assembly environment                                                             | Instructions                                                    |
| ------------- | ----: | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| APPLARO bench |     4 | [Open](https://3dwebagent.davidz.cn/?episode=examples/applaro/scene.episode.zip) | [Manual](https://3dwebagent.davidz.cn/examples/applaro/manual/) |
| REIDAR chair  |     6 | [Open](https://3dwebagent.davidz.cn/?episode=examples/reidar/scene.episode.zip)  | [Manual](https://3dwebagent.davidz.cn/examples/reidar/manual/)  |
| VITTSJO table |     8 | [Open](https://3dwebagent.davidz.cn/?episode=examples/vittsjo/scene.episode.zip) | [Manual](https://3dwebagent.davidz.cn/examples/vittsjo/manual/) |

**APPLARO bench**

```text
Assemble the APPLARO bench in this browser environment:
https://3dwebagent.davidz.cn/?episode=examples/applaro/scene.episode.zip

Follow the assembly manual at:
https://3dwebagent.davidz.cn/examples/applaro/manual/

Use the environment's WebMCP tools to inspect and position the parts.
Capture the scene to check your work against the manual.
```

**REIDAR chair**

```text
Assemble the REIDAR chair in this browser environment:
https://3dwebagent.davidz.cn/?episode=examples/reidar/scene.episode.zip

Follow the assembly manual at:
https://3dwebagent.davidz.cn/examples/reidar/manual/

Use the environment's WebMCP tools to inspect and position the parts.
Capture the scene to check your work against the manual.
```

**VITTSJO table**

```text
Assemble the VITTSJO table in this browser environment:
https://3dwebagent.davidz.cn/?episode=examples/vittsjo/scene.episode.zip

Follow the assembly manual at:
https://3dwebagent.davidz.cn/examples/vittsjo/manual/

Use the environment's WebMCP tools to inspect and position the parts.
Capture the scene to check your work against the manual.
```

The agent discovers tools such as `list_objects`, `get_object`, `set_object_pose`,
and `capture_scene`. Watch it work and orbit the scene independently; reload the
environment URL to start again. These three episodes use pose-based assembly:
physics stepping and collisions are disabled in their original configuration.

Episodes and original manual pages come from
[AssemblyWorld/ikea-manual](https://huggingface.co/datasets/AssemblyWorld/ikea-manual).
See [demo provenance](examples/source.json) for the pinned revision and archive hashes.

Already using an agent with native WebMCP support? Open the link in its connected
browser and start prompting. Otherwise, follow the one-time setup below.
No project checkout, Python installation, or API key in the website is required.

## Connect through WebMCP

WebMCP lets a **live browser page** expose tools to an agent. Keep the environment
open in the browser your agent controls. The demo URL opens a world; it is not
an HTTP MCP server endpoint.

### Codex with built-in site tools

In a Codex desktop setup that supports site tools, ask Codex to open the demo in
its **built-in browser** and use the page's WebMCP tools. No separate MCP server
is needed for this route. Availability depends on the app version, model, and
workspace; see [OpenAI's site tools guide](https://learn.chatgpt.com/docs/webmcp).

### Codex CLI or Claude Code with Chrome

Use [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
to connect your coding agent to a WebMCP-enabled browser:

1. Install current Chrome (149 or newer) and a current Node.js LTS release.
2. In Chrome, enable `chrome://flags/#enable-webmcp-testing` and relaunch.
3. Open `chrome://inspect/#remote-debugging` and enable remote debugging.
   Use a browser profile dedicated to agent work: the connection can access
   other tabs and signed-in sessions in that profile.
4. Run the command for your agent:

**Codex CLI**

```sh
codex mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --autoConnect --categoryExperimentalWebmcp
```

**Claude Code**

```sh
claude mcp add --scope user chrome-devtools -- npx -y chrome-devtools-mcp@latest --autoConnect --categoryExperimentalWebmcp
```

Restart your agent session, allow Chrome's connection prompt, and give the agent
the demo URL and task above. Ask it to discover and invoke the page's WebMCP tools.

In 3DWebAgent, open **View → WebMCP** to check tool registration. If the browser
API is unavailable, check the Chrome flag and relaunch. If tools are registered
but your agent cannot see them, check its browser connection and the
`--categoryExperimentalWebmcp` option.

Setup references: [Chrome WebMCP](https://developer.chrome.com/docs/ai/webmcp),
[browser connection and flags](https://developer.chrome.com/docs/devtools/agents/get-started/configuration),
[agent client configurations](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md).

## What is an episode?

An **episode** is a portable world and its interaction history, saved as an
`.episode.zip` file. It contains the model and assets, physics settings, object
and camera states, agent tool calls with their arguments and results, simulation
frames, and captured observations. It is the source of truth for a run.

- **Set up:** open an episode or import OBJ objects; edit the scene, physics,
  camera, and available tools before the agent starts.
- **Interact:** the first agent call starts recording, including a query. Later
  manual world edits are recorded as human interventions. Free observation and
  view navigation do not change the agent camera or recorded world.
- **Inspect and share:** use the Timeline to inspect calls and physics frames.
  Export the full episode to keep the run, or export the current state as an
  initial episode for a new task. Save before closing the tab.

Drag an episode ZIP onto the page to reopen it. To share a starting world by URL,
host the ZIP over HTTPS and pass its URL in the `episode` query parameter
(URL-encoded; cross-origin hosts must allow CORS). The recipient loads their own
copy; sharing a URL does not synchronize browser sessions.

For programmatic producers and readers, see the [episode schema](schema/episode.schema.json),
[tool definitions](schema/tools.json), and [Python runtime](python/episode_runtime.py).

### Optional precompiled MJB episodes

Episode format 1 also accepts `manifest.model: {"format":"mjb","path":"model.mjb"}`
with the compiled model stored at `world/model.mjb`. Without this declaration the
existing `world/model.xml` behavior is unchanged. MJB archives require a runtime
with this extension; older XML-only runtimes cannot open them. Both producers and
runtimes must use MuJoCo 3.12.0. MJB assets participate in the normal archive hashes.

MJB loads the compiled model directly, avoiding browser mesh compilation. It does
not simplify geometry and can be larger than source meshes. These episodes have
fixed parts: poses, groups, cameras, queries, captures and replay remain available;
adding/deleting objects and editing model properties are unavailable. Export keeps
the original MJB bytes and records state changes separately. XML scenes retain
their existing editing capabilities and remain the default.
