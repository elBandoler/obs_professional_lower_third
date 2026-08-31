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
	nlohmann::json defaultsLook();
	nlohmann::json defaultsAnim();
	nlohmann::json defaultsSettings();
	nlohmann::json defaultsPresets();
	static nlohmann::json deepMerge(const nlohmann::json &base, const nlohmann::json &over);
	static nlohmann::json sanitize(const nlohmann::json &v, int depth = 0);

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
