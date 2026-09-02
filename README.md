# OBS Lower Thirds

Broadcast-style animated lower thirds for OBS Studio, with a real **preview → air** workflow:
you edit in the dock's preview, nothing touches the program feed, and the change goes live —
animated — when you press **SHOW** or OBS's own **Transition** button.

- **Fully dynamic layout** — add, remove, duplicate and move as many text and image elements
  as you like. Two-line news straps, headline-only, badges/tags, a logo on either side or
  filling the whole height: all of it is just elements you arrange.
- Full styling control per element: colours, opacity, **multi-stop linear/radial/conic
  gradients**, background pictures, fonts, sizes, weights, spacing, padding, RTL/LTR,
  slanted/rounded/square edges, accent strips, shadows
- **Saved text presets per element** — recall a wording with one tap (loads to preview only)
- Animations: slide / wipe / fade / pop in-out, animated text swaps, property morphing,
  stagger, easing, durations — or disable animations entirely for instant cuts
- Presets (built-in + your own), auto-hide timer, logo upload
- Control panel docks **inside** OBS; also works from another browser/tablet on your machine
- HTTP API for Stream Deck / hotkey tools

It ships as a native C++ OBS plugin that renders through OBS's own browser engine, so text,
animation and styling are broadcast quality. A Node.js server and an OBS Lua script are
included as alternatives that serve exactly the same pages.

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
| Preview mirror | `http://127.0.0.1:3620/overlay?role=preview` | Open in a **normal browser window** only — never as an OBS source |

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

*Let OBS's Transition button commit pending changes:*
1. In OBS: *Tools → WebSocket Server Settings* → **Enable WebSocket server**, copy the password
   (OBS 28+ has this built in).
2. In the dock: *OBS & INTEGRATIONS* → enter the password → enable **Connect to OBS**.
3. Enable **Studio Mode** in OBS. Now every **Transition** commits your pending lower-third
   changes to program, animated — or instantly, if animations are off.

## 3. The preview / program workflow

- Everything you type or restyle goes to the **pending** state. **The dock's preview pane is
  the preview** — it shows the change immediately, and the program overlay does not move.
- **SHOW** commits pending → program and animates the lower third in. It is the only way on
  air from the dock:
  - text lines swap with an animation, colors/sizes/positions morph smoothly,
  - structural changes (an element added/removed/moved) do a quick out-and-in,
  - with **animations off** (checkbox next to SHOW, or Animation section): the change applies
    **instantly**, no motion.
- **HIDE** animates it out.
- OBS's **Transition** button (and `/api/take`) commits pending → program as well, so a change
  you have staged goes live with your next transition.
- **discard changes** reverts pending back to what's on air.

**OBS's own Preview cannot show the pending version.** A source renders once and the same
pixels are painted into both Preview and Program — OBS has no concept of a source that exists
only in the Preview view. So there is no way to see "what is about to go on air" inside OBS's
Preview pane, for this or any other source.

That is why **the preview lives in the dock**, right above the SHOW / HIDE buttons. It is a
real render of the pending look and it can never reach air.

If you want it bigger, open `http://127.0.0.1:3620/overlay?role=preview` **in an ordinary
browser window** — on a second monitor, for example. A browser window is outside OBS, so it
cannot be transitioned to program by accident.

Do **not** add `?role=preview` as a source in an OBS scene. Any scene can be transitioned to
program, and that source always shows your unfinished edits — it is a trap, not a preview.

## 4. Options overview

The **preview** at the top is the only preview there is, so it is yours to size: drag its
right edge or the bottom-right corner to make it as big or small as you want (double-click a
handle to reset). The size is remembered per machine.

The dock has two views, toggled with the **SIMPLE / ADVANCED** button in its header
(remembered per machine):

- **Simple** — operator mode: the SHOW / HIDE controls, one text box per text element with
  its saved-text chips underneath, and — **at the bottom, out of the way** — quick-launch
  buttons for every saved preset (tap → loads into the preview). Loading a preset replaces
  the whole look, so it sits below the text boxes where a hand won't find it by accident;
  the preset editor (overwrite / delete) is hidden entirely in this view.
- **Advanced** — the full editor below.

Advanced sections:

- **Elements** — the lower third is a list of elements you can add, remove, duplicate and
  move. Each is either **text** or an **image**, and each has its own colours, gradient,
  background picture, type, padding, edges and accent strip.
  - **＋ text / ＋ image** adds one; **⧉ copy** duplicates; **✕ remove** deletes.
  - **Drag the ⠿ grip** on a card to reorder elements — within a row, into another row, or
    onto the **FULL HEIGHT** heading to make an element span every row (drag it back into a
    row to undo). Reordering inside a row swaps the elements' column slots, so the other rows
    keep their alignment. A blue line shows where the card will land; drag it off the list or
    press **Escape** to abandon the move. The **▲ ▼ ◀ ▶** buttons do the same thing one step
    at a time, and **own row** gives an element a row to itself. Elements sharing a cell sit
    side by side on one line.
  - **Stretch to fill** makes an element take the remaining width of its row.
  - **Pin to edge** pushes an element to the far left or far right of its row. Two elements
    sharing a row can then sit at opposite ends — one hard against the left edge, the other
    tucked against the logo — instead of packing together.
  - **Full height** makes it span every row — that is how you get a logo standing beside the
    whole block instead of a badge above it.
  - Columns are shared between rows, so an element keeps lining up with the one above it
    (a badge stays exactly above a logo).
- **Text presets (per element)** — under every text element, **＋ save text** stores its
  current wording. Tap a saved chip to load it back. Loading only fills the **preview** —
  nothing reaches air until you press SHOW.
- **Layout & position** — direction (auto/RTL/LTR), default text align, full width or
  anchored (left/center/right) with max width, side/bottom margins, gap between blocks.
- **Colours (per element)** — background + opacity + text colour, **multi-stop gradients**
  (linear, radial or conic; add as many colour stops as you like, drag them on the gradient
  strip, each with its own position and opacity), **background image** (upload or URL,
  cover/contain/stretch/tile — the colour acts as a tint over the picture, lower its opacity
  to reveal more image), accent strip (top/bottom/side).
- **Fonts** — a **default font** for the whole lower third, plus a **per-element font**: each
  text element has its own *Font* box (same searchable list of fonts installed on the PC and
  fonts you uploaded). Leave it empty and the element follows the default; the ⟲ button puts
  it back. A per-element font still falls back to the default stack, so Hebrew keeps
  rendering even if the chosen font has no Hebrew glyphs.
  You can also **upload font files** (.ttf/.otf/.woff/.woff2 — stored with the overlay, usable
  immediately) or point at a font CSS URL (e.g. Google Fonts — needs internet at runtime).
  Size, weight, letter-spacing, line-height and padding are per element too.
- **Edges & effects** — global square / rounded (radius) / slanted (amount) and shadow.
  Any element can override the global edge style with its own.
- **Animation** — master enable, in/out/text-change styles, easing, durations, stagger,
  auto-hide after N seconds.
- **Presets** (the last section, deliberately — loading one throws away everything in the
  preview) — five built in, including **Headline + subtitle** (a big headline with a smaller
  line under it) — plus save/load/overwrite/delete of your own complete looks (all elements +
  style + animation). Loading a preset only changes the *preview*; SHOW puts it on air.
  Presets are what the SIMPLE view's quick-launch buttons run.

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
