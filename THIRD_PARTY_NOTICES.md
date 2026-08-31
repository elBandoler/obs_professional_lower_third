# Third-party components

This repository vendors a couple of small third-party libraries under
`plugin/vendor/` so the native plugin builds without extra package managers.
`plugin/deps/fetch-deps.ps1` also downloads OBS Studio's own headers at build
time (not redistributed here).

- **civetweb** (`plugin/vendor/civetweb/`) — embedded HTTP/WebSocket server.
  MIT License. https://github.com/civetweb/civetweb
- **nlohmann/json** (`plugin/vendor/json/json.hpp`) — JSON for Modern C++,
  single header. MIT License. https://github.com/nlohmann/json
- **OBS Studio headers** (fetched, not committed) — `libobs` and
  `obs-frontend-api` headers, used only to compile against the OBS plugin
  ABI. GPL-2.0. https://github.com/obsproject/obs-studio

The rest of this repository (the server, web UI, and plugin glue code) is
licensed under the MIT License — see [LICENSE](LICENSE).
