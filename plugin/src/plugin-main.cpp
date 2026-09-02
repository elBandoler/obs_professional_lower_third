/* OBS Lower Thirds — native plugin
 * --------------------------------
 * Runs the lower-thirds graphics server inside OBS (embedded civetweb),
 * hooks the Studio Mode Transition to commit pending changes, registers a
 * "Lower Third" source and a Tools-menu entry for the control panel.
 */

#include <obs-module.h>
#include <obs-frontend-api.h>
#include <util/bmem.h>

#include <atomic>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shellapi.h>
#endif

#include "lt-state.h"
#include "lt-server.h"

OBS_DECLARE_MODULE()

MODULE_EXPORT const char *obs_module_description(void)
{
	return "Broadcast lower thirds with a preview/take workflow (control panel dock, "
	       "animated overlay, commit-on-transition).";
}

MODULE_EXPORT const char *obs_module_name(void)
{
	return "Lower Thirds";
}

void lt_register_source(void); /* lt-source.cpp */

static LtState g_state;
static LtServer g_server;
static int g_port = 3620;
static std::atomic<bool> g_unloading{false};

/* server start retry (port may be briefly busy, e.g. old node server) */
static std::thread g_retryThread;
static std::mutex g_retryMtx;
static std::condition_variable g_retryCv;
static bool g_retryStop = false;

static std::string g_webRoot;
static std::string g_uploadDir;

void lt_log(const char *fmt, ...)
{
	char buf[1024];
	va_list args;
	va_start(args, fmt);
	vsnprintf(buf, sizeof(buf), fmt, args);
	va_end(args);
	blog(LOG_INFO, "[obs-lowerthirds] %s", buf);
}

int lt_server_port(void)
{
	return g_port;
}

/* ------------------------------------------------------- transitions */

static void on_transition_start(void *, calldata_t *)
{
	if (g_unloading)
		return;
	if (!g_state.commitOnTransition())
		return;
	if (g_state.onlyStudioMode() && !obs_frontend_preview_program_mode_active())
		return;
	g_state.take("obs");
}

static void refresh_transition_hooks(void)
{
	struct obs_frontend_source_list list = {};
	obs_frontend_get_transitions(&list);
	for (size_t i = 0; i < list.sources.num; i++) {
		obs_source_t *tr = list.sources.array[i];
		signal_handler_t *sh = obs_source_get_signal_handler(tr);
		if (!sh)
			continue;
		signal_handler_disconnect(sh, "transition_start", on_transition_start, nullptr);
		signal_handler_connect(sh, "transition_start", on_transition_start, nullptr);
	}
	obs_frontend_source_list_free(&list);
}

static void broadcast_obs_status(void)
{
	if (g_server.running())
		g_server.broadcastText(g_state.obsStatusPayload().dump(), nullptr);
}

static void on_frontend_event(enum obs_frontend_event event, void *)
{
	switch (event) {
	case OBS_FRONTEND_EVENT_FINISHED_LOADING:
	case OBS_FRONTEND_EVENT_TRANSITION_CHANGED:
	case OBS_FRONTEND_EVENT_TRANSITION_LIST_CHANGED:
	case OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGED:
		refresh_transition_hooks();
		break;
	case OBS_FRONTEND_EVENT_STUDIO_MODE_ENABLED:
	case OBS_FRONTEND_EVENT_STUDIO_MODE_DISABLED:
		broadcast_obs_status();
		break;
	case OBS_FRONTEND_EVENT_EXIT:
		g_state.flushSave();
		break;
	default:
		break;
	}
}

/* -------------------------------------------------------- tools menu */

static void open_control_panel(void *)
{
	char url[128];
	snprintf(url, sizeof(url), "http://127.0.0.1:%d/control", g_port);
#ifdef _WIN32
	ShellExecuteA(nullptr, "open", url, nullptr, nullptr, SW_SHOWNORMAL);
#endif
}

/* ------------------------------------------------------------- load */

static bool try_start_server(void)
{
	if (g_server.start(g_port, g_webRoot, g_uploadDir, &g_state)) {
		lt_log("server listening on http://127.0.0.1:%d (control: /control, overlay: /overlay)", g_port);
		return true;
	}
	return false;
}

bool obs_module_load(void)
{
	char *cfg = obs_module_config_path("");
	if (!cfg) {
		blog(LOG_ERROR, "[obs-lowerthirds] no config path");
		return false;
	}
	std::string configDir = cfg;
	bfree(cfg);

	char *web = obs_module_file("public");
	if (!web) {
		blog(LOG_ERROR, "[obs-lowerthirds] data/public not found — plugin data files missing");
		return false;
	}
	g_webRoot = web;
	bfree(web);

	std::error_code ec;
	std::filesystem::create_directories(configDir, ec);
	g_uploadDir = (std::filesystem::path(configDir) / "uploads").string();
	std::filesystem::create_directories(g_uploadDir, ec);

	/* defaults.json ships next to the web assets and is shared with the
	   Node server, so both engines start from identical defaults */
	LtState::setDefaultsPath((std::filesystem::path(g_webRoot) / "defaults.json").string());

	g_state.init(configDir,
		     [](const std::string &text, const char *role) {
			     g_server.broadcastText(text, role);
		     },
		     []() { return obs_frontend_preview_program_mode_active(); });

	g_port = g_state.serverPort();

	if (!try_start_server()) {
		lt_log("port %d busy — will keep retrying every 10s "
		       "(is the standalone Node server or another app using it?)",
		       g_port);
		g_retryStop = false;
		g_retryThread = std::thread([] {
			std::unique_lock<std::mutex> lk(g_retryMtx);
			while (!g_retryStop) {
				g_retryCv.wait_for(lk, std::chrono::seconds(10));
				if (g_retryStop)
					return;
				if (try_start_server())
					return;
			}
		});
	}

	lt_register_source();
	obs_frontend_add_event_callback(on_frontend_event, nullptr);
	obs_frontend_add_tools_menu_item("Lower Thirds Panel", open_control_panel, nullptr);

	lt_log("loaded (v1.4.0)");
	return true;
}

void obs_module_unload(void)
{
	g_unloading = true;
	{
		std::lock_guard<std::mutex> lk(g_retryMtx);
		g_retryStop = true;
	}
	g_retryCv.notify_all();
	if (g_retryThread.joinable())
		g_retryThread.join();

	obs_frontend_remove_event_callback(on_frontend_event, nullptr);
	g_server.stop();
	g_state.shutdown();
	lt_log("unloaded");
}
