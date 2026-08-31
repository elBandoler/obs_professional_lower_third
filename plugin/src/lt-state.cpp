#include "lt-state.h"

#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>

using nlohmann::json;
namespace fs = std::filesystem;

extern void lt_log(const char *fmt, ...); /* provided by plugin-main */

/* ------------------------------------------------------------- defaults */

json LtState::defaultsLook()
{
	static const char *LOOK = R"({
	  "content": {
	    "topline": { "enabled": true, "text": "שינוי כיוון – עם ד\"ר ניסים כץ" },
	    "headline": { "text": "הביקורת על הימין בכלל ועל נתניהו בפרט" },
	    "badge": { "enabled": true, "text": "knesset.tv/live" },
	    "logo": { "enabled": true, "url": "/assets/logo-placeholder.svg", "scale": 1 }
	  },
	  "style": {
	    "direction": "auto",
	    "textAlign": "start",
	    "layout": { "anchor": "left", "fullWidth": true, "maxWidth": 70,
	                "sideMargin": 0, "bottomMargin": 64, "logoSide": "right" },
	    "bars": {
	      "headline": { "bg": "#ffffff", "bgOpacity": 1, "color": "#0d2b6b",
	                    "size": 56, "weight": 800, "letterSpacing": 0, "padX": 30, "padY": 16,
	                    "gradient": { "enabled": false, "color2": "#e9edf5", "angle": 180 },
	                    "image": { "enabled": false, "url": "", "fit": "cover" } },
	      "topline": { "bg": "#ffffff", "bgOpacity": 0.95, "color": "#12161c",
	                   "size": 28, "weight": 600, "letterSpacing": 0, "padX": 24, "padY": 9,
	                   "image": { "enabled": false, "url": "", "fit": "cover" } },
	      "badge": { "bg": "#1c56d6", "color": "#ffffff", "size": 23, "weight": 700 },
	      "logoBox": { "bg": "#ffffff", "bgOpacity": 1, "pad": 12, "minWidth": 180 }
	    },
	    "font": { "family": "'Segoe UI', 'Heebo', 'Noto Sans Hebrew', Arial, sans-serif",
	              "customCssUrl": "", "uploads": [] },
	    "edges": { "style": "square", "radius": 14, "chamfer": 26 },
	    "accent": { "mode": "none", "color": "#1c56d6", "thickness": 6 },
	    "shadow": 40,
	    "gap": 4
	  }
	})";
	return json::parse(LOOK);
}

json LtState::defaultsAnim()
{
	static const char *ANIM = R"({
	  "enabled": true,
	  "inStyle": "slide-up", "outStyle": "auto", "changeStyle": "slide-swap",
	  "inMs": 700, "outMs": 500, "changeMs": 450, "staggerMs": 90,
	  "easing": "snappy", "autoHideSec": 0
	})";
	return json::parse(ANIM);
}

json LtState::defaultsSettings()
{
	/* native mode: no obs-websocket connection settings needed, but the
	   transition behaviour toggles are kept (same paths the panel uses) */
	static const char *SETTINGS = R"({
	  "obs": { "enabled": true, "host": "", "port": 0, "password": "",
	           "commitOnTransition": true, "onlyStudioMode": true,
	           "transitionAction": "take" },
	  "server": { "port": 3620 }
	})";
	return json::parse(SETTINGS);
}

json LtState::defaultsPresets()
{
	json base = defaultsLook();

	json breaking = base;
	breaking["content"] = json::parse(R"({
	  "topline": { "enabled": true, "text": "BREAKING NEWS" },
	  "headline": { "text": "Major story developing right now" },
	  "badge": { "enabled": true, "text": "LIVE" },
	  "logo": { "enabled": true, "url": "/assets/logo-placeholder.svg", "scale": 1 }
	})");
	breaking["style"]["direction"] = "ltr";
	breaking["style"]["bars"]["headline"] = json::parse(R"({
	  "bg": "#b31217", "bgOpacity": 1, "color": "#ffffff",
	  "size": 54, "weight": 800, "letterSpacing": 1, "padX": 30, "padY": 16,
	  "gradient": { "enabled": true, "color2": "#7a0c10", "angle": 180 }
	})");
	breaking["style"]["bars"]["topline"] = json::parse(R"({
	  "bg": "#111111", "bgOpacity": 1, "color": "#ffd400",
	  "size": 26, "weight": 800, "letterSpacing": 4, "padX": 24, "padY": 8
	})");
	breaking["style"]["bars"]["badge"] = json::parse(R"({ "bg": "#ffffff", "color": "#b31217", "size": 22, "weight": 800 })");
	breaking["style"]["bars"]["logoBox"] = json::parse(R"({ "bg": "#111111", "bgOpacity": 1, "pad": 12, "minWidth": 170 })");
	breaking["style"]["edges"] = json::parse(R"({ "style": "chamfer", "radius": 0, "chamfer": 24 })");
	json breakingAnim = defaultsAnim();
	breakingAnim["inStyle"] = "wipe";

	json strap = base;
	strap["content"] = json::parse(R"({
	  "topline": { "enabled": true, "text": "Senior Political Analyst" },
	  "headline": { "text": "Dana Cohen" },
	  "badge": { "enabled": false, "text": "" },
	  "logo": { "enabled": false, "url": "", "scale": 1 }
	})");
	strap["style"]["direction"] = "ltr";
	strap["style"]["layout"] = json::parse(R"({ "anchor": "left", "fullWidth": false, "maxWidth": 46,
	  "sideMargin": 80, "bottomMargin": 90, "logoSide": "left" })");
	strap["style"]["bars"]["headline"] = json::parse(R"({
	  "bg": "#101418", "bgOpacity": 0.88, "color": "#ffffff",
	  "size": 46, "weight": 700, "letterSpacing": 0, "padX": 28, "padY": 12,
	  "gradient": { "enabled": false, "color2": "#101418", "angle": 180 }
	})");
	strap["style"]["bars"]["topline"] = json::parse(R"({
	  "bg": "#1c56d6", "bgOpacity": 1, "color": "#ffffff",
	  "size": 22, "weight": 600, "letterSpacing": 2, "padX": 20, "padY": 6
	})");
	strap["style"]["edges"] = json::parse(R"({ "style": "rounded", "radius": 8, "chamfer": 0 })");
	strap["style"]["accent"] = json::parse(R"({ "mode": "side", "color": "#1c56d6", "thickness": 6 })");
	json strapAnim = defaultsAnim();
	strapAnim["inStyle"] = "slide-side";
	strapAnim["autoHideSec"] = 8;

	json grad = base;
	grad["content"] = json::parse(R"({
	  "topline": { "enabled": false, "text": "" },
	  "headline": { "text": "Evening Headlines" },
	  "badge": { "enabled": false, "text": "" },
	  "logo": { "enabled": true, "url": "/assets/logo-placeholder.svg", "scale": 0.9 }
	})");
	grad["style"]["direction"] = "ltr";
	grad["style"]["textAlign"] = "center";
	grad["style"]["layout"] = json::parse(R"({ "anchor": "center", "fullWidth": false, "maxWidth": 50,
	  "sideMargin": 0, "bottomMargin": 72, "logoSide": "left" })");
	grad["style"]["bars"]["headline"] = json::parse(R"({
	  "bg": "#182848", "bgOpacity": 0.96, "color": "#ffffff",
	  "size": 48, "weight": 700, "letterSpacing": 0, "padX": 34, "padY": 16,
	  "gradient": { "enabled": true, "color2": "#4b6cb7", "angle": 115 }
	})");
	grad["style"]["bars"]["logoBox"] = json::parse(R"({ "bg": "#0e1a33", "bgOpacity": 0.96, "pad": 12, "minWidth": 120 })");
	grad["style"]["edges"] = json::parse(R"({ "style": "rounded", "radius": 16, "chamfer": 0 })");
	json gradAnim = defaultsAnim();
	gradAnim["inStyle"] = "pop";
	gradAnim["easing"] = "bouncy";

	json presets = json::array();
	presets.push_back({{"id", "p-knesset"}, {"name", "News two-line (RTL demo)"},
			   {"content", base["content"]}, {"style", base["style"]}, {"anim", defaultsAnim()}});
	presets.push_back({{"id", "p-breaking"}, {"name", "Breaking news (red)"},
			   {"content", breaking["content"]}, {"style", breaking["style"]}, {"anim", breakingAnim}});
	presets.push_back({{"id", "p-strap"}, {"name", "Name strap (minimal)"},
			   {"content", strap["content"]}, {"style", strap["style"]}, {"anim", strapAnim}});
	presets.push_back({{"id", "p-gradient"}, {"name", "Centered gradient"},
			   {"content", grad["content"]}, {"style", grad["style"]}, {"anim", gradAnim}});
	return presets;
}

/* ---------------------------------------------------------------- utils */

json LtState::deepMerge(const json &base, const json &over)
{
	if (!base.is_object() || !over.is_object())
		return over;
	json out = base;
	for (auto it = over.begin(); it != over.end(); ++it) {
		const std::string &k = it.key();
		if (k == "__proto__" || k == "constructor" || k == "prototype")
			continue;
		if (out.contains(k))
			out[k] = deepMerge(out[k], it.value());
		else
			out[k] = it.value();
	}
	return out;
}

json LtState::sanitize(const json &v, int depth)
{
	if (depth > 12)
		return nullptr;
	if (v.is_string()) {
		std::string s = v.get<std::string>();
		if (s.size() > 4000)
			s.resize(4000);
		return s;
	}
	if (v.is_number()) {
		double d = v.get<double>();
		if (d > 1e6) d = 1e6;
		if (d < -1e6) d = -1e6;
		return d;
	}
	if (v.is_boolean() || v.is_null())
		return v;
	if (v.is_array()) {
		json out = json::array();
		size_t n = 0;
		for (const auto &x : v) {
			if (n++ >= 200) break;
			out.push_back(sanitize(x, depth + 1));
		}
		return out;
	}
	if (v.is_object()) {
		json out = json::object();
		for (auto it = v.begin(); it != v.end(); ++it) {
			const std::string &k = it.key();
			if (k == "__proto__" || k == "constructor" || k == "prototype")
				continue;
			out[k] = sanitize(it.value(), depth + 1);
		}
		return out;
	}
	return nullptr;
}

static long long now_ms()
{
	return (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
		       std::chrono::system_clock::now().time_since_epoch())
		.count();
}

std::string LtState::newPresetId()
{
	static std::mt19937_64 rng((uint64_t)std::chrono::steady_clock::now().time_since_epoch().count());
	std::ostringstream o;
	o << "p-" << std::hex << (rng() & 0xffffffffffULL);
	return o.str();
}

/* ------------------------------------------------------------ lifecycle */

void LtState::init(const std::string &configDir, BroadcastFn broadcast, StudioModeFn studioMode)
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	dir = configDir;
	bfn = broadcast;
	smfn = studioMode;

	st = json::object();
	st["live"] = defaultsLook();
	st["pending"] = defaultsLook();
	st["anim"] = defaultsAnim();
	st["settings"] = defaultsSettings();
	st["visible"] = false;
	st["shownAt"] = 0;
	st["presets"] = defaultsPresets();

	loadLocked();
	scheduleAutoHideLocked();

	stopWorker = false;
	worker = std::thread([this] { workerLoop(); });
}

void LtState::shutdown()
{
	{
		std::lock_guard<std::recursive_mutex> lk(mtx);
		stopWorker = true;
		if (savePending)
			saveNowLocked();
		savePending = false;
	}
	cv.notify_all();
	if (worker.joinable())
		worker.join();
}

void LtState::loadLocked()
{
	try {
		fs::path f = fs::path(dir) / "state.json";
		if (!fs::exists(f))
			return;
		std::ifstream in(f, std::ios::binary);
		json saved = json::parse(in, nullptr, true, true);
		if (saved.contains("live"))
			st["live"] = deepMerge(defaultsLook(), saved["live"]);
		if (saved.contains("pending"))
			st["pending"] = deepMerge(defaultsLook(), saved["pending"]);
		if (saved.contains("anim"))
			st["anim"] = deepMerge(defaultsAnim(), saved["anim"]);
		if (saved.contains("settings"))
			st["settings"] = deepMerge(defaultsSettings(), saved["settings"]);
		st["visible"] = saved.value("visible", false);
		st["shownAt"] = saved.value("shownAt", 0LL);
		if (saved.contains("presets") && saved["presets"].is_array())
			st["presets"] = saved["presets"];
		lt_log("restored state from %s", f.string().c_str());
	} catch (const std::exception &e) {
		lt_log("could not read saved state (starting fresh): %s", e.what());
	}
}

void LtState::saveNowLocked()
{
	try {
		fs::path f = fs::path(dir) / "state.json";
		fs::path tmp = fs::path(dir) / "state.json.tmp";
		{
			std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
			out << st.dump(2);
		}
		std::error_code ec;
		fs::rename(tmp, f, ec);
		if (ec) {
			fs::remove(f, ec);
			fs::rename(tmp, f, ec);
		}
	} catch (const std::exception &e) {
		lt_log("failed to save state: %s", e.what());
	}
}

void LtState::flushSave()
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	saveNowLocked();
	savePending = false;
}

void LtState::scheduleSaveLocked()
{
	savePending = true;
	saveDue = std::chrono::steady_clock::now() + std::chrono::milliseconds(400);
	cv.notify_all();
}

void LtState::scheduleAutoHideLocked()
{
	int sec = st["anim"].value("autoHideSec", 0);
	if (st["visible"].get<bool>() && sec > 0) {
		hidePending = true;
		hideDue = std::chrono::steady_clock::now() + std::chrono::seconds(sec);
	} else {
		hidePending = false;
	}
	cv.notify_all();
}

void LtState::cancelAutoHideLocked()
{
	hidePending = false;
	cv.notify_all();
}

void LtState::workerLoop()
{
	std::unique_lock<std::recursive_mutex> lk(mtx);
	while (!stopWorker) {
		auto next = std::chrono::steady_clock::now() + std::chrono::hours(24);
		if (savePending && saveDue < next)
			next = saveDue;
		if (hidePending && hideDue < next)
			next = hideDue;
		cv.wait_until(lk, next);
		if (stopWorker)
			break;
		auto now = std::chrono::steady_clock::now();
		if (savePending && now >= saveDue) {
			savePending = false;
			saveNowLocked();
		}
		if (hidePending && now >= hideDue) {
			hidePending = false;
			hide("auto");
		}
	}
}

/* ------------------------------------------------------------ payloads */

bool LtState::isDirtyLocked()
{
	return st["live"] != st["pending"];
}

json LtState::publicStateLocked()
{
	json out = json::object();
	out["live"] = st["live"];
	out["pending"] = st["pending"];
	out["anim"] = st["anim"];
	out["settings"] = st["settings"];
	out["visible"] = st["visible"];
	out["shownAt"] = st["shownAt"];
	out["presets"] = st["presets"];
	out["dirty"] = isDirtyLocked();
	out["native"] = true;
	return out;
}

json LtState::publicState()
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	return publicStateLocked();
}

json LtState::obsStatusPayload()
{
	json out = json::object();
	out["type"] = "obs";
	out["status"] = "connected";
	out["native"] = true;
	out["studioMode"] = smfn ? smfn() : false;
	return out;
}

std::string LtState::helloText(const json &counts)
{
	json msg = json::object();
	msg["type"] = "hello";
	msg["state"] = publicState();
	msg["obs"] = obsStatusPayload();
	msg["counts"] = counts;
	return msg.dump();
}

void LtState::broadcastJson(const json &msg, const char *role)
{
	if (bfn)
		bfn(msg.dump(), role);
}

/* -------------------------------------------------------------- actions */

bool LtState::take(const char *source)
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	if (!isDirtyLocked())
		return false;
	st["live"] = st["pending"];
	saveNowLocked();
	bool animate = st["anim"].value("enabled", true);
	broadcastJson({{"type", "commit"}, {"live", st["live"]}, {"animate", animate}, {"dirty", false}});
	lt_log("TAKE (%s)%s", source, animate ? " animated" : " instant");
	if (std::string(source) == "obs" &&
	    st["settings"]["obs"].value("transitionAction", "take") == "take-show" &&
	    !st["visible"].get<bool>()) {
		show("obs");
	}
	return true;
}

void LtState::show(const char *source)
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	st["live"] = st["pending"];
	st["visible"] = true;
	st["shownAt"] = now_ms();
	saveNowLocked();
	bool animate = st["anim"].value("enabled", true);
	broadcastJson({{"type", "show"},
		       {"live", st["live"]},
		       {"animate", animate},
		       {"visible", true},
		       {"shownAt", st["shownAt"]},
		       {"dirty", false}});
	scheduleAutoHideLocked();
	lt_log("SHOW (%s)", source);
}

void LtState::hide(const char *source)
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	if (!st["visible"].get<bool>())
		return;
	st["visible"] = false;
	saveNowLocked();
	cancelAutoHideLocked();
	bool animate = st["anim"].value("enabled", true);
	broadcastJson({{"type", "hide"}, {"animate", animate}, {"visible", false}});
	lt_log("HIDE (%s)", source);
}

void LtState::toggleVisible(const char *source)
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	if (st["visible"].get<bool>())
		hide(source);
	else
		show(source);
}

void LtState::revert()
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	st["pending"] = st["live"];
	scheduleSaveLocked();
	broadcastJson({{"type", "pending"}, {"pending", st["pending"]}, {"dirty", false}});
}

void LtState::applyEdit(const json &patch)
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	st["pending"] = deepMerge(st["pending"], sanitize(patch));
	scheduleSaveLocked();
	broadcastJson({{"type", "pending"}, {"pending", st["pending"]}, {"dirty", isDirtyLocked()}});
}

bool LtState::commitOnTransition()
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	return st["settings"]["obs"].value("commitOnTransition", true);
}

bool LtState::onlyStudioMode()
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	return st["settings"]["obs"].value("onlyStudioMode", true);
}

int LtState::serverPort()
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	int p = st["settings"]["server"].value("port", 3620);
	if (p < 1024 || p > 65535)
		p = 3620;
	return p;
}

/* ------------------------------------------------------- client messages */

void LtState::handleClientMessage(const json &msg)
{
	std::string t = msg.value("type", "");
	std::lock_guard<std::recursive_mutex> lk(mtx);

	if (t == "edit") {
		applyEdit(msg.value("patch", json::object()));
	} else if (t == "anim") {
		st["anim"] = deepMerge(st["anim"], sanitize(msg.value("patch", json::object())));
		scheduleSaveLocked();
		broadcastJson({{"type", "anim"}, {"anim", st["anim"]}});
		scheduleAutoHideLocked();
	} else if (t == "settings") {
		st["settings"] = deepMerge(st["settings"], sanitize(msg.value("patch", json::object())));
		scheduleSaveLocked();
		broadcastJson({{"type", "settings"}, {"settings", st["settings"]}});
	} else if (t == "take") {
		take("manual");
	} else if (t == "show") {
		show("manual");
	} else if (t == "hide") {
		hide("manual");
	} else if (t == "toggle") {
		toggleVisible("manual");
	} else if (t == "revert") {
		revert();
	} else if (t == "preview-anim") {
		broadcastJson({{"type", "preview-anim"}}, "preview");
	} else if (t == "reset-style") {
		st["pending"]["style"] = defaultsLook()["style"];
		scheduleSaveLocked();
		broadcastJson({{"type", "pending"}, {"pending", st["pending"]}, {"dirty", isDirtyLocked()}});
	} else if (t == "preset-save") {
		std::string name = msg.value("name", "Preset");
		if (name.size() > 60)
			name.resize(60);
		json p = {{"id", newPresetId()},
			  {"name", name},
			  {"content", st["pending"]["content"]},
			  {"style", st["pending"]["style"]},
			  {"anim", st["anim"]}};
		st["presets"].push_back(p);
		scheduleSaveLocked();
		broadcastJson({{"type", "presets"}, {"presets", st["presets"]}});
	} else if (t == "preset-update") {
		std::string id = msg.value("id", "");
		for (auto &p : st["presets"]) {
			if (p.value("id", "") == id) {
				p["content"] = st["pending"]["content"];
				p["style"] = st["pending"]["style"];
				p["anim"] = st["anim"];
				break;
			}
		}
		scheduleSaveLocked();
		broadcastJson({{"type", "presets"}, {"presets", st["presets"]}});
	} else if (t == "preset-load") {
		std::string id = msg.value("id", "");
		for (auto &p : st["presets"]) {
			if (p.value("id", "") == id) {
				st["pending"]["content"] = deepMerge(defaultsLook()["content"], p["content"]);
				st["pending"]["style"] = deepMerge(defaultsLook()["style"], p["style"]);
				if (p.contains("anim"))
					st["anim"] = deepMerge(defaultsAnim(), p["anim"]);
				scheduleSaveLocked();
				broadcastJson({{"type", "pending"}, {"pending", st["pending"]}, {"dirty", isDirtyLocked()}});
				broadcastJson({{"type", "anim"}, {"anim", st["anim"]}});
				break;
			}
		}
	} else if (t == "preset-delete") {
		std::string id = msg.value("id", "");
		json out = json::array();
		for (auto &p : st["presets"])
			if (p.value("id", "") != id)
				out.push_back(p);
		st["presets"] = out;
		scheduleSaveLocked();
		broadcastJson({{"type", "presets"}, {"presets", st["presets"]}});
	} else if (t == "preset-restore") {
		json defs = defaultsPresets();
		for (auto &d : defs) {
			bool have = false;
			for (auto &p : st["presets"])
				if (p.value("name", "") == d.value("name", ""))
					have = true;
			if (!have)
				st["presets"].push_back(d);
		}
		scheduleSaveLocked();
		broadcastJson({{"type", "presets"}, {"presets", st["presets"]}});
	}
}
