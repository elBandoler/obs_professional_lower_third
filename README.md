# OBS Lower Thirds

Broadcast-style animated lower thirds for OBS Studio, with a real **preview → take** workflow:
you edit in a preview, nothing touches the program feed, and the change goes live — animated —
when you press **TAKE** or OBS's own **Transition** button.

- Two-line (top line + headline), headline-only, badge/tag ("LIVE", a URL…), customizable logo
- Full styling control: colors, opacity, gradients, fonts, sizes, weights, spacing, padding,
  position, width, RTL/LTR, slanted/rounded/square edges, accent strips, shadows, block gaps
- Animations: slide / wipe / fade / pop in-out, animated text swaps, property morphing,
  stagger, easing, durations — or disable animations entirely for instant cuts
- Presets (built-in + your own), auto-hide timer, logo upload
- Control panel docks **inside** OBS; also works from another browser/tablet on your machine
- HTTP API for Stream Deck / hotkey tools

It is delivered the way modern broadcast graphics integrate with OBS (browser source +
browser dock + obs-websocket), not as a compiled C++ plugin — that is what allows
high-quality text rendering, animation, and unlimited styling.

---

## 1. Quick start

**Option A — native OBS plugin (recommended, no Node.js needed):**
1. Run **`plugin\dist\obs-lowerthirds-setup.exe`** (installs per-user, no admin needed;
   build it yourself with `plugin\build.ps1` + Inno Setup if you got this repo without dist).
2. Restart OBS. The plugin runs the graphics server *inside* OBS:
   - control panel dock: *View → Docks → Lower Thirds* (also *Tools → Lower Thirds Panel*)
   - add a **"Lower Third"** source to your scenes (no URL copying needed)
   - OBS's **Transition** button commits pending changes natively — no obs-websocket setup
3. Uninstall via Windows "Installed apps" like any program.

**Option B — Lua script + Node server:**
Install [Node.js LTS](https://nodejs.org), run `npm install` once, then in OBS:
*Tools → Scripts → +* → pick **`obs-lower-thirds.lua`**. The Node server starts/stops with
OBS. Use this on machines where you prefer the JS server (or for hacking on it).

**Option C — standalone Node server:**
Double-click **`Start Lower Thirds.bat`** and leave the window open. Works without OBS —
useful when another program consumes the overlay. Don't run B or C at the same time as the
native plugin on the same port — whoever binds 3620 first wins (the plugin retries and logs).

All three serve identical pages and state files, so you can switch between them.

You'll see the URLs it serves:

| Page | URL | Use |
|---|---|---|
| Control panel | `http://127.0.0.1:3620/control` | OBS custom browser dock |
| Program overlay | `http://127.0.0.1:3620/overlay` | Browser source in your scenes |
| Preview mirror | `http://127.0.0.1:3620/overlay?role=preview` | Optional preview source/projector |

## 2. Set up OBS

**With the native plugin (Option A):** add a **"Lower Third"** source to your scenes, open
the *Lower Thirds* dock, enable **Studio Mode** — done. The Transition button already
commits changes. (The browser-source/dock URLs below still work too if you prefer them.)

**With the Node server (Options B/C):**

*Overlay (program):*
1. In your scene: *Sources → + → Browser*, name it e.g. `Lower Third`.
2. URL: `http://127.0.0.1:3620/overlay` — Width **1920**, Height **1080**.
3. Leave "Shutdown source when not visible" **off** so it stays connected.

*Control dock:*
1. *View → Docks → Custom Browser Docks…*
2. Name: `Lower Thirds`, URL: `http://127.0.0.1:3620/control` → Apply.

*Let OBS's Transition button do the TAKE:*
1. In OBS: *Tools → WebSocket Server Settings* → **Enable WebSocket server**, copy the password
   (OBS 28+ has this built in).
2. In the dock: *OBS & INTEGRATIONS* → enter the password → enable **Connect to OBS**.
3. Enable **Studio Mode** in OBS. Now every **Transition** commits your pending lower-third
   changes to program, animated — or instantly, if animations are off.

## 3. The preview / program workflow

- Everything you type or restyle goes to the **pending** state. The dock's preview pane (and
  any `?role=preview` source) shows it immediately. **The program overlay does not change.**
- **TAKE** (dock button, or OBS **Transition**, or `/api/take`) commits pending → program:
  - text lines swap with an animation, colors/sizes/positions morph smoothly,
  - structural changes (logo side, line added/removed…) do a quick out-and-in,
  - with **animations off** (checkbox next to TAKE, or Animation section): the change applies
    **instantly**, no motion.
- **SHOW** commits pending and animates the lower third in; **HIDE** animates it out.
- **discard changes** reverts pending back to what's on air.

**Why the OBS Preview window itself can't show the pending text:** OBS renders one browser
source instance and paints the *same* pixels into Preview and Program — no source can display
two different things at once. That's why the control dock has its own preview pane, and why
there is a separate **preview mirror** URL (`/overlay?role=preview`) you can use as:
- a source in a scene that never goes to program (e.g. a "GFX PREVIEW" scene), or
- a *Windowed Projector*: right-click the source → Windowed Projector.

Never put the `role=preview` source in a scene that goes live — it always shows pending edits.

## 4. Options overview

The dock has two views, toggled with the **SIMPLE / ADVANCED** button in its header
(remembered per machine):

- **Simple** — operator mode: quick-launch buttons for every saved preset (tap → loads into
  the preview), the three text fields (top line / headline / badge — only the enabled ones),
  and the SHOW / TAKE / HIDE controls. Nothing else to touch mid-show.
- **Advanced** — the full editor below.

Advanced sections:

- **Content** — top line on/off + text, headline, badge on/off + text, logo on/off,
  upload/URL, logo size.
- **Layout & position** — direction (auto/RTL/LTR), text align, logo side, full width or
  anchored (left/center/right) with max width, side/bottom margins, gap between blocks.
- **Colors & bars** — background + opacity + text color per bar, headline gradient (2nd color +
  angle), **background image per bar** (upload or URL, cover/contain/stretch/tile — the bar's
  color acts as a tint over the picture, lower its opacity to reveal more image), badge
  colors, logo box color/padding/min-width, accent strip (top/side/underline).
- **Typography** — **pick any font installed on the PC** (searchable list), **upload font
  files** (.ttf/.otf/.woff/.woff2 — stored with the overlay, usable immediately), raw font
  stack, custom font CSS URL (e.g. Google Fonts — needs internet at runtime),
  size/weight/letter-spacing/padding per line, badge size/weight.
- **Edges & effects** — square / rounded (radius) / slanted (amount), shadow.
- **Animation** — master enable, in/out/text-change styles, easing, durations, stagger,
  auto-hide after N seconds.
- **Presets** — save/load/overwrite/delete complete looks (content + style + animation).
  Loading a preset only changes the *preview*; TAKE or SHOW puts it on air.

Hebrew/Arabic content is auto-detected (or force RTL) and the whole layout mirrors properly.

## 5. Hotkeys / Stream Deck / automation

Any tool that can hit a URL can drive it:

```
GET http://127.0.0.1:3620/api/take      commit pending -> program
GET http://127.0.0.1:3620/api/show      commit + animate in
GET http://127.0.0.1:3620/api/hide      animate out
GET http://127.0.0.1:3620/api/toggle    show/hide
GET http://127.0.0.1:3620/api/revert    discard pending
GET http://127.0.0.1:3620/api/pending?headline=Hello&topline=World&take=1
POST http://127.0.0.1:3620/api/pending  (JSON patch of content/style)
GET http://127.0.0.1:3620/api/state     full state as JSON
GET http://127.0.0.1:3620/api/quit      shut the server down
```

## 6. Tips & troubleshooting

- **Port busy / second instance:** `node server.js --port 3621 --data data2` gives you a fully
  independent second lower third (own overlay + dock URLs).
- **Control from a tablet/another PC:** start with `node server.js --host 0.0.0.0` and open
  `http://<your-pc-ip>:3620/control` (allow it in Windows Firewall).
- **Fonts:** the overlay uses fonts installed on the OBS machine (default stack is
  Hebrew-friendly). For Google Fonts, paste the CSS URL into *Typography → Font CSS URL* and
  put the family name in the font stack.
- **Nothing on program?** Check the `PGM ✓` pill in the dock header — `PGM 0` means no browser
  source is connected to `/overlay`.
- **OBS pill says "auth!"** — wrong WebSocket password; fix it, then toggle *Connect to OBS*
  off/on.
- Everything (state, presets, uploaded logos) persists in the `data/` folder for the Node
  server, and in `%APPDATA%\obs-studio\plugin_config\obs-lowerthirds\` for the native
  plugin; back those up to keep your looks.

## 7. Building the native plugin from source

Requirements: VS Build Tools 2022 (C++ workload), OBS Studio installed, Inno Setup 6.

```
powershell -ExecutionPolicy Bypass -File plugin\build.ps1
```

builds `plugin\dist\obs-lowerthirds\` (the plugin tree) against your installed OBS —
import libraries are generated from OBS's own DLLs, so the build always matches the
installed OBS ABI. Then compile the installer:

```
ISCC.exe plugin\installer\obs-lowerthirds.iss
```

which produces `plugin\dist\obs-lowerthirds-setup.exe`. The plugin embeds a C web server
(civetweb) and the same state engine as `server.js`, serves the same `public/` assets, and
hooks transitions through OBS's frontend API directly.
