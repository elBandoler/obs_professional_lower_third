# OBS Lower Thirds

Broadcast-style animated lower thirds for OBS Studio, with a real **preview → air** workflow:
you edit in the dock's preview, nothing touches the program feed, and the change goes live —
animated — when you press **SHOW** or OBS's own **Transition** button.

- **Fully dynamic layout** — add, remove, duplicate and move as many text and image elements
  as you like. Two-line news straps, headline-only, badges/tags, a logo on either side or
  filling the whole height: all of it is just elements you arrange.
- **Video, GIF and rotating logos** — a logo can be a still, an animated GIF or a short
  muted video (MP4/WebM/MOV), and one element can hold several and swap between them on a
  timer, either cycling or ducking away from a main logo and back
- Full styling control per element: colours, opacity, **multi-stop linear/radial/conic
  gradients**, background pictures, fonts, sizes, weights, spacing, padding, RTL/LTR,
  slanted/rounded/square edges, accent strips, shadows
- **Saved text presets per element** — recall a wording with one tap (loads to preview only)
- Animations: slide / wipe / fade / pop in-out, animated text swaps, property morphing,
  stagger, easing, durations — or disable animations entirely for instant cuts
- **Per-element motion** — give one element its own entrance, and link it to another
  element's logo rotation so it carries the swap (a chevron that flicks the logo over)
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
   - the redesigned **Studio** dock: *View → Docks → Lower Thirds Studio* (also *Tools → Lower Thirds Studio*) — see *Two docks* below
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
| Studio panel (redesigned) | `http://127.0.0.1:3620/studio` | OBS custom browser dock |
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

### Two docks: Classic and Studio

From v1.7.0 the plugin ships two control panels over the same server, state and
protocol. Both are registered as OBS docks by the installer, and both are in the
Tools menu.

| | **Classic** — `/control` | **Studio** — `/studio` |
|---|---|---|
| What it is | The dock as it has always been: Simple/Advanced modes, element cards with tabs | A redesigned deck for running a show |
| Best for | Building looks, deep per-element editing | Live operation: cue the next line, put it on air, know what is on air |
| Changes | Unchanged in this release | New |

**How Studio works**

- The top of the dock is a **deck that never scrolls**: the NEXT preview
  (cropped to the strap so a 320px dock shows it large), a two-line readout —
  *what is on air now* and *what SHOW/UPDATE will change* — and the transport.
- The one big button is **SHOW** when nothing is on air, **UPDATE** when NEXT
  differs from AIR, and an inert **ON AIR ✓** when they match. There is no
  separate TAKE. **HIDE** counts down when auto-hide is set.
- Two places instead of two modes: **AIR** is the cue sheet — one card per
  element with only the text and an eye — and **DESIGN** holds the element
  inspector (one continuous form with a jump bar), the layout map (drag chips
  between rows), the look, and presets. Tap a bar in the preview, a card, or a
  chip: it is the same selection everywhere.
- **Saved lines** sit under each text card as numbered rows: the cued line has
  a green outline, the on-air line a red dot. `▸` cues the next saved line;
  typing filters them; long-press or `⋯` renames or deletes.
- Anything destructive is **two taps**: "discard edits" on the readout, delete,
  overwrite. Loading a preset is **arm, then LOAD** — the arm quotes how many
  unsent edits it will discard — and comes with a 15-second **Undo**.
- **Keyboard**: `Ctrl+Enter` shows/updates from anywhere. Plain `Enter` in a
  text field does nothing unless "Enter arms SHOW" is on under LOOK › DOCK (then
  it arms the button and a second `Enter` fires it). `Alt+↑/↓` walk the
  elements; `Esc` cancels an arm or clears the selection.
- At **900px or wider** the dock becomes two columns — AIR on the left, DESIGN
  on the right — with a draggable splitter.

Nothing in Studio is private: an edit in one dock appears in the other, and
the overlay does not care which dock sent it.

## 4. Options overview

The **preview** at the top is the only preview there is, so it is yours to size: drag its
right edge or the bottom-right corner to make it as big or small as you want (double-click a
handle to reset). The size is remembered per machine.

The dock has two views, toggled with the **SIMPLE / ADVANCED** button in its header
(remembered per machine):

- **Simple** — operator mode: the preview, the SHOW / HIDE controls, and one text box per
  text element with its saved-text chips underneath. **Nothing that loads a preset is
  reachable here** — a single tap would replace the whole look — so presets, both the
  quick-launch buttons and the editor, are hidden in this view. Switch to ADVANCED to load
  one. Saved *texts* still work per element, which is the recall an operator actually wants
  mid-show.
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
- **Logos: stills, video and rotation** — an image element's picture can be a still
  (PNG/JPG/SVG/**GIF**, which animates as it always has) or a short **video**
  (**MP4 / WebM / MOV**). Video logos play muted and looping — upload one with the same
  📁 button; nothing else to set up.
  - Under **MORE LOGOS** you can give one element several logos. The picture in the *Image*
    box stays the **main** logo; the ones you add below are the alternates.
  - **Rotate logos** then offers two behaviours:
    - **Cycle through all** — the main logo and every alternate take turns, swapping every
      *Swap every* seconds.
    - **Swap out, then return to main** — the main logo stays up; every *Swap every* seconds
      an alternate takes over for *Alternate stays for* seconds, then the main logo comes
      back. This is the one for a sponsor or a "coming up next" ident.
  - The change is animated — **fade**, **slide up**, **push across**, **wipe across**,
    **flip**, **cube turn**, **zoom**, **iris** or a hard **cut** — with its own duration.
    *Push* and *wipe* travel with the reading direction; *cube* is a quarter turn in
    perspective, which is the one that reads as a station ident rather than a dissolve. With the master **animations** switch off, rotation still runs but cuts
    instead of animating.
  - Rotation is a display behaviour: it never edits your look, so the dock does not go
    "unsaved" every few seconds, and it pauses whenever the lower third is off air.
  - Mix freely — a still main logo that flips to a video sting and back is just three
    entries and *Swap out, then return to main*.
- **Motion (per element)** — every element card has a **MOTION** tab, so one element can
  move differently from the rest.
  - **Entrance** overrides the look's in-animation for this element alone. *Slide from the
    side* enters from the right on an RTL layout and from the left on LTR; the exit mirrors
    whatever you pick. **Entrance time** and **Extra delay** let you land it after the
    elements around it — the delay is on top of the stagger, not instead of it.
  - **React to a logo change** links this element to another element's logo rotation. Pick a
    logo under *When this changes*, and every time that logo rotates to its next picture,
    this element **flicks through**, **enters again** or **pulses**. Put a chevron, a rule or
    a divider next to a rotating logo and it carries the change instead of the picture
    swapping on its own.
  - **Cover the swap** holds the logo change until the reacting element is halfway through
    its move, so the picture changes *behind* the motion rather than beside it. Turn it off
    if you want them to fire together.
  - Any element can react to any image element — it is not tied to a particular shape, so
    whatever art you drop in is what moves.
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
- **Edges & effects** — global square / rounded (radius) / slanted (amount) / **chevron** and
  shadow. Any element can override the global edge style with its own.
  - **Chevron** points the element the way the text reads and notches the other end, so a row
    of segments set to `gap: 0` chains into one arrow ribbon. It is a clip on the element, not
    artwork — so each segment's colour is just its own background and every one of them
    recolours independently. *Chevron depth* controls how far the point reaches.
    The point follows the **reading direction** — right on an LTR layout, left on RTL — so
    the ribbon reads as an arrow travelling with the sentence rather than against it.
  - One caveat: the **wipe** entrance animates the same clip the shape uses, so an element
    with slanted or chevron edges shows as a plain rectangle for the length of a wipe and
    snaps to its shape at the end. Give clipped elements a different entrance — slide, fade
    or pop — which is what the built-in chevron preset does.
- **Animation** — master enable, in/out/text-change styles, easing, durations, stagger,
  auto-hide after N seconds.
- **Artwork shape detection** — drop a cut-out picture (a chevron on a transparent
  background, say) into an image element and the dock reads its alpha channel and tells you
  what it found: how much of it is transparent, which way its point faces and how deep that
  point is, and whether the file has transparent padding baked into it.
  - **Notch the bars to fit** then gives every other element on that row a chevron edge at
    exactly the measured depth, so your artwork slots into the bar instead of sitting beside
    it — no measuring, no typing a number into *Chevron depth*.
  - **Trim N px margin** scales the picture up to fill padding baked into the file, so it
    stops sitting smaller than its box.
  - It is careful about what it calls a chevron: the reach has to grow *linearly* from the
    ends toward the middle, which is what a diagonal edge does. A rounded logo reaches its
    full width almost immediately, so it is reported as cut-out artwork and nothing else.
  - The reading happens in the dock, where the browser already has an image decoder. A
    picture loaded from another server cannot be measured (the canvas is locked); upload it
    and it can be.
- **Bundled artwork** — `public/assets/` ships `chevron-blue.svg` and
  `chevron-purple.svg`: a plain two-tone chevron pointing in the RTL reading
  direction. They are ordinary SVGs, so they stay crisp at any size and you can
  recolour them by editing the two `fill` values. Drop in your own artwork
  whenever you like — nothing in the code knows what a chevron is.
- **Presets** and **Quick** (the last two sections, deliberately — loading one throws away
  everything in the preview, so neither sits where a hand lands first) — six built in,
  including **Headline + subtitle** (a big headline with a smaller line under it) and
  **Chevron ribbon + rotating logo** (four interlocking chevron segments — cap, headline,
  divider, logo plate — that read as one arrow ribbon, every colour editable, with the
  divider already wired to flick when the logo rotates and the logo set to a cube turn. Add
  your logos under MORE LOGOS, set *Rotate logos*, and it runs) —
  plus save/load/overwrite/delete of your own complete looks (all elements + style +
  animation).
  *Quick* is the same list as big one-tap buttons. Loading a preset only changes the
  *preview*; SHOW puts it on air. Both are ADVANCED-only.

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
- **Video logo not playing?** It must be a format the OBS browser engine can decode — WebM
  (VP8/VP9) and H.264 MP4 are safe. Uploads are capped at 64 MB; a logo sting should be a
  small fraction of that. Audio is always muted.
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
