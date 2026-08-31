--[[
  OBS Lower Thirds — launcher script
  ----------------------------------
  Add this file in OBS under  Tools → Scripts  (keep it inside the
  lower-thirds folder, next to server.js).

  What it does:
    • starts the graphics server (node server.js) automatically when OBS
      starts, hidden, no console window
    • the server watches OBS's process id and shuts itself down when OBS
      exits (even after a crash) — nothing is left running
    • gives you buttons to start/stop the server and open the control panel

  You still add the two URLs once (see README):
    Browser source : http://127.0.0.1:3620/overlay
    Custom dock    : http://127.0.0.1:3620/control
]]

local obs = obslua

local cfg = {
  autostart = true,
  port = 3620,
  node_path = "node",
}

local is_windows = package.config:sub(1, 1) == "\\"
local ffi_ok, ffi = pcall(require, "ffi")
local shell32 = nil

if ffi_ok then
  pcall(ffi.cdef, [[
    void* ShellExecuteA(void* hwnd, const char* op, const char* file,
                        const char* params, const char* dir, int show);
    unsigned long GetCurrentProcessId(void);
  ]])
  if is_windows then
    local ok, lib = pcall(ffi.load, "Shell32")
    if ok then shell32 = lib end
  end
end

local function obs_pid()
  if ffi_ok then
    local ok, pid = pcall(function() return tonumber(ffi.C.GetCurrentProcessId()) end)
    if ok and pid then return pid end
  end
  return 0
end

-- run a program without opening a console window (Windows), or detached (other OS)
local function run_hidden(file, params, workdir)
  if shell32 then
    shell32.ShellExecuteA(nil, "open", file, params, workdir, 0) -- 0 = SW_HIDE
    return
  end
  if is_windows then
    os.execute('start "" /b "' .. file .. '" ' .. (params or ""))
  else
    os.execute("cd '" .. (workdir or ".") .. "' && nohup '" .. file .. "' " ..
      (params or "") .. " >/dev/null 2>&1 &")
  end
end

local function server_dir()
  local dir = script_path()
  if is_windows then dir = dir:gsub("/", "\\") end
  return dir
end

local function launch_server()
  local dir = server_dir()
  local params = '"' .. dir .. 'server.js" --port ' .. cfg.port
  local pid = obs_pid()
  if pid > 0 then params = params .. " --watch-pid " .. pid end
  run_hidden(cfg.node_path, params, dir)
end

local function stop_server()
  local url = "http://127.0.0.1:" .. cfg.port .. "/api/quit"
  if is_windows then
    run_hidden("curl.exe", '-s -m 2 "' .. url .. '"', nil)
  else
    os.execute('curl -s -m 2 "' .. url .. '" >/dev/null 2>&1 &')
  end
end

local function open_panel()
  local url = "http://127.0.0.1:" .. cfg.port .. "/control"
  if shell32 then
    shell32.ShellExecuteA(nil, "open", url, nil, nil, 1) -- 1 = SW_SHOWNORMAL
  elseif is_windows then
    os.execute('start "" "' .. url .. '"')
  else
    os.execute('(xdg-open "' .. url .. '" || open "' .. url .. '") >/dev/null 2>&1 &')
  end
end

-- second launch attempt shortly after startup: harmless if the first one is
-- already listening (the extra process sees the port in use and exits), and
-- covers the case where a previous instance was still releasing the port
local function retry_once()
  obs.remove_current_callback()
  launch_server()
end

----------------------------------------------------------------- OBS hooks

function script_description()
  return [[<b>OBS Lower Thirds — server launcher</b><br>
Starts the lower-thirds graphics server with OBS and stops it when OBS exits.<br><br>
One-time setup (see README.md): add the <code>/overlay</code> browser source
and the <code>/control</code> custom browser dock.<br><br>
If you disable or remove this script while OBS is running, use
<i>Stop server</i> first — otherwise the server keeps running until OBS closes.]]
end

function script_defaults(settings)
  obs.obs_data_set_default_bool(settings, "autostart", true)
  obs.obs_data_set_default_int(settings, "port", 3620)
  obs.obs_data_set_default_string(settings, "node_path", "node")
end

function script_update(settings)
  cfg.autostart = obs.obs_data_get_bool(settings, "autostart")
  cfg.port = obs.obs_data_get_int(settings, "port")
  cfg.node_path = obs.obs_data_get_string(settings, "node_path")
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_bool(props, "autostart", "Start graphics server with OBS")
  obs.obs_properties_add_int(props, "port", "Server port", 1024, 65535, 1)
  obs.obs_properties_add_text(props, "node_path", "Node.js executable", obs.OBS_TEXT_DEFAULT)
  obs.obs_properties_add_button(props, "btn_start", "Start server now",
    function() launch_server() return false end)
  obs.obs_properties_add_button(props, "btn_stop", "Stop server",
    function() stop_server() return false end)
  obs.obs_properties_add_button(props, "btn_open", "Open control panel in browser",
    function() open_panel() return false end)
  return props
end

function script_load(settings)
  script_update(settings)
  if cfg.autostart then
    launch_server()
    obs.timer_add(retry_once, 8000)
  end
end

function script_unload()
  -- intentionally empty: the server watches OBS's pid and exits on its own
end
