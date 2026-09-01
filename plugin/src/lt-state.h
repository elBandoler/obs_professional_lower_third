#pragma once

#include <string>
#include <functional>
#include <mutex>
#include <thread>
#include <condition_variable>
#include <chrono>

#include "json.hpp"

/* State engine for the lower thirds. A direct port of the Node server's
 * state model so the existing web control panel / overlay work unchanged:
 *   pending -> what is being edited (preview)
 *   live    -> what is on air (program)
 * TAKE / SHOW commit pending -> live and broadcast to all websocket clients.
 */
class LtState {
public:
	using BroadcastFn = std::function<void(const std::string &text, const char *roleFilter)>;
	using StudioModeFn = std::function<bool()>;

	/* where defaults.json lives (data/public/defaults.json) — call before init */
	static void setDefaultsPath(const std::string &path);

	void init(const std::string &configDir, BroadcastFn broadcast, StudioModeFn studioMode);
	void shutdown();

	nlohmann::json publicState();
	nlohmann::json obsStatusPayload();
	std::string helloText(const nlohmann::json &counts);

	void handleClientMessage(const nlohmann::json &msg);

	bool take(const char *source);
	void show(const char *source);
	void hide(const char *source);
	void toggleVisible(const char *source);
	void revert();
	void applyEdit(const nlohmann::json &patch);

	bool commitOnTransition();
	bool onlyStudioMode();
	int serverPort();

	void flushSave();

private:
	static nlohmann::json defaultsLook();
	static nlohmann::json defaultsAnim();
	static nlohmann::json defaultsSettings();
	static nlohmann::json defaultsPresets();
	static nlohmann::json defaultsStyle();
	static nlohmann::json defaultElement(const char *kind);

	/* schema 1 (fixed slots) -> schema 2 (dynamic elements); idempotent */
	static nlohmann::json migrateLook(const nlohmann::json &look);
	static nlohmann::json migratePreset(const nlohmann::json &preset);
	static nlohmann::json normalizeElement(const nlohmann::json &el);
	static void normalizePlacement(nlohmann::json &els);
	static std::string newId(const char *prefix);

	static nlohmann::json deepMerge(const nlohmann::json &base, const nlohmann::json &over);
	static nlohmann::json sanitize(const nlohmann::json &v, int depth = 0);

	/* element / snippet helpers used by handleClientMessage */
	nlohmann::json *findElement(const std::string &id);
	void pushPendingLocked();

	bool isDirtyLocked();
	nlohmann::json publicStateLocked();
	void broadcastJson(const nlohmann::json &msg, const char *role = nullptr);
	void scheduleSaveLocked();
	void scheduleAutoHideLocked();
	void cancelAutoHideLocked();
	void saveNowLocked();
	void loadLocked();
	void workerLoop();
	std::string newPresetId();

	std::recursive_mutex mtx;
	nlohmann::json st; /* {live,pending,anim,settings,visible,shownAt,presets} */
	std::string dir;
	BroadcastFn bfn;
	StudioModeFn smfn;

	std::thread worker;
	std::condition_variable_any cv;
	bool stopWorker = false;
	bool savePending = false;
	bool hidePending = false;
	std::chrono::steady_clock::time_point saveDue{};
	std::chrono::steady_clock::time_point hideDue{};
};
