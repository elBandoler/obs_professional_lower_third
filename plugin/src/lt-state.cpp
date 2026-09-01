#include "lt-state.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <map>
#include <random>
#include <sstream>
#include <stdexcept>
#include <vector>

using nlohmann::json;
namespace fs = std::filesystem;

extern void lt_log(const char *fmt, ...); /* provided by plugin-main */

/* ------------------------------------------------- defaults & migration
 *
 * The real defaults, element templates and built-in presets live in
 * data/public/defaults.json, which the Node server reads too — one source of
 * truth so the two engines cannot drift apart. Only a tiny fallback is
 * compiled in, for the case where that file is missing.
 */

static json g_defaults;          /* loaded from defaults.json */
static std::string g_defaultsPath;

static json minimalDefaults()
{
	static const char *MIN = R"({
	  "schema": 2,
	  "elementDefaults": {
	    "text": { "kind": "text", "name": "Text", "enabled": true,
	      "place": { "row": 0, "col": 0, "order": 0, "stretch": false, "spanAll": false, "rowSpan": 1, "colSpan": 1 },
	      "text": "New text", "snippets": [],
	      "style": { "bg": "#ffffff", "bgOpacity": 1, "color": "#12161c", "size": 40, "weight": 700,
	        "letterSpacing": 0, "padX": 26, "padY": 12, "lineHeight": 1.2, "align": "auto",
	        "nowrap": false, "minWidth": 0,
	        "gradient": { "enabled": false, "type": "linear", "angle": 180, "shape": "ellipse", "posX": 50, "posY": 50,
	          "stops": [ { "color": "#ffffff", "pos": 0, "opacity": 1 }, { "color": "#e9edf5", "pos": 100, "opacity": 1 } ] },
	        "bgImage": { "enabled": false, "url": "", "fit": "cover" },
	        "edges": { "mode": "inherit", "radius": 14, "chamfer": 26 },
	        "accent": { "mode": "none", "color": "#1c56d6", "thickness": 6 } } },
	    "image": { "kind": "image", "name": "Image", "enabled": true,
	      "place": { "row": 0, "col": 0, "order": 0, "stretch": false, "spanAll": false, "rowSpan": 1, "colSpan": 1 },
	      "image": { "url": "", "fit": "contain", "scale": 1 },
	      "style": { "bg": "#ffffff", "bgOpacity": 1, "color": "#12161c", "size": 56, "weight": 700,
	        "letterSpacing": 0, "padX": 12, "padY": 12, "lineHeight": 1.2, "align": "center",
	        "nowrap": false, "minWidth": 160,
	        "gradient": { "enabled": false, "type": "linear", "angle": 180, "shape": "ellipse", "posX": 50, "posY": 50,
	          "stops": [ { "color": "#ffffff", "pos": 0, "opacity": 1 }, { "color": "#e9edf5", "pos": 100, "opacity": 1 } ] },
	        "bgImage": { "enabled": false, "url": "", "fit": "cover" },
	        "edges": { "mode": "inherit", "radius": 14, "chamfer": 26 },
	        "accent": { "mode": "none", "color": "#1c56d6", "thickness": 6 } } }
	  },
	  "styleDefaults": {
	    "direction": "auto", "textAlign": "start",
	    "layout": { "anchor": "left", "fullWidth": true, "maxWidth": 70, "sideMargin": 0, "bottomMargin": 64 },
	    "gap": 4,
	    "font": { "family": "Segoe UI, Arial, sans-serif", "customCssUrl": "", "uploads": [] },
	    "edges": { "style": "square", "radius": 14, "chamfer": 26 },
	    "shadow": 40
	  },
	  "anim": { "enabled": true, "inStyle": "slide-up", "outStyle": "auto", "changeStyle": "slide-swap",
	    "inMs": 700, "outMs": 500, "changeMs": 450, "staggerMs": 90, "easing": "snappy", "autoHideSec": 0 },
	  "look": { "schema": 2, "elements": [ { "id": "el-headline", "kind": "text", "name": "Headline",
	      "enabled": true, "place": { "row": 0, "col": 0, "order": 0, "stretch": true, "spanAll": false, "rowSpan": 1, "colSpan": 1 },
	      "text": "Lower third", "snippets": [],
	      "style": { "bg": "#ffffff", "bgOpacity": 1, "color": "#0d2b6b", "size": 56, "weight": 800,
	        "letterSpacing": 0, "padX": 30, "padY": 16, "lineHeight": 1.18, "align": "auto",
	        "nowrap": false, "minWidth": 0,
	        "gradient": { "enabled": false, "type": "linear", "angle": 180, "shape": "ellipse", "posX": 50, "posY": 50,
	          "stops": [ { "color": "#ffffff", "pos": 0, "opacity": 1 }, { "color": "#e9edf5", "pos": 100, "opacity": 1 } ] },
	        "bgImage": { "enabled": false, "url": "", "fit": "cover" },
	        "edges": { "mode": "inherit", "radius": 14, "chamfer": 26 },
	        "accent": { "mode": "none", "color": "#1c56d6", "thickness": 6 } } } ],
	    "style": { "direction": "auto", "textAlign": "start",
	      "layout": { "anchor": "left", "fullWidth": true, "maxWidth": 70, "sideMargin": 0, "bottomMargin": 64 },
	      "gap": 4, "font": { "family": "Segoe UI, Arial, sans-serif", "customCssUrl": "", "uploads": [] },
	      "edges": { "style": "square", "radius": 14, "chamfer": 26 }, "shadow": 40 } },
	  "presets": []
	})";
	return json::parse(MIN);
}

void LtState::setDefaultsPath(const std::string &path)
{
	g_defaultsPath = path;
}

static void ensureDefaultsLoaded()
{
	if (!g_defaults.is_null())
		return;
	try {
		if (g_defaultsPath.empty())
			throw std::runtime_error("no defaults path");
		std::ifstream in(g_defaultsPath, std::ios::binary);
		if (!in)
			throw std::runtime_error("cannot open " + g_defaultsPath);
		json d = json::parse(in, nullptr, true, true);
		if (!d.contains("look") || !d.contains("elementDefaults") ||
		    !d.contains("styleDefaults") || !d.contains("anim"))
			throw std::runtime_error("incomplete defaults.json");
		g_defaults = d;
		lt_log("loaded defaults from %s", g_defaultsPath.c_str());
	} catch (const std::exception &e) {
		lt_log("could not read defaults.json (%s) - using the built-in minimal look", e.what());
		g_defaults = minimalDefaults();
	}
}

json LtState::defaultElement(const char *kind)
{
	ensureDefaultsLoaded();
	const char *k = (kind && std::string(kind) == "image") ? "image" : "text";
	return g_defaults["elementDefaults"][k];
}

json LtState::defaultsStyle()
{
	ensureDefaultsLoaded();
	return g_defaults["styleDefaults"];
}

json LtState::defaultsLook()
{
	ensureDefaultsLoaded();
	return migrateLook(g_defaults["look"]);
}

json LtState::defaultsAnim()
{
	ensureDefaultsLoaded();
	return g_defaults["anim"];
}

json LtState::defaultsPresets()
{
	ensureDefaultsLoaded();
	json out = json::array();
	if (g_defaults.contains("presets") && g_defaults["presets"].is_array()) {
		for (const auto &p : g_defaults["presets"]) {
			json m = migratePreset(p);
			if (!m.is_null())
				out.push_back(m);
		}
	}
	return out;
}

json LtState::defaultsSettings()
{
	static const char *SETTINGS = R"({
	  "obs": { "enabled": true, "host": "", "port": 0, "password": "",
	           "commitOnTransition": true, "onlyStudioMode": true,
	           "transitionAction": "take" },
	  "server": { "port": 3620 }
	})";
	return json::parse(SETTINGS);
}

/* ------------------------------------------------------------ migration */

std::string LtState::newId(const char *prefix)
{
	static std::mt19937_64 rng((uint64_t)std::chrono::steady_clock::now().time_since_epoch().count());
	std::ostringstream o;
	o << prefix << "-" << std::hex << (rng() & 0xffffffffULL);
	return o.str();
}

static double numOr(const json &j, const char *key, double dflt)
{
	if (j.is_object() && j.contains(key) && j[key].is_number())
		return j[key].get<double>();
	return dflt;
}

static int clampInt(double v, int lo, int hi)
{
	int i = (int)v;
	if (i < lo) i = lo;
	if (i > hi) i = hi;
	return i;
}

static bool boolOr(const json &o, const char *k, bool dflt)
{
	if (o.is_object() && o.contains(k) && o[k].is_boolean())
		return o[k].get<bool>();
	return dflt;
}

static json strOr(const json &o, const char *k, const char *dflt)
{
	if (o.is_object() && o.contains(k) && o[k].is_string())
		return o[k];
	return json(dflt);
}

json LtState::normalizeElement(const json &in)
{
	if (!in.is_object())
		return json();
	std::string kind = (in.contains("kind") && in["kind"].is_string() &&
	                    in["kind"].get<std::string>() == "image") ? "image" : "text";
	json base = defaultElement(kind.c_str());
	json out = deepMerge(base, in);
	out["kind"] = kind;
	if (!out.contains("id") || !out["id"].is_string() || out["id"].get<std::string>().empty())
		out["id"] = newId("el");
	if (!out.contains("name") || !out["name"].is_string())
		out["name"] = kind == "image" ? "Image" : "Text";
	out["enabled"] = boolOr(out, "enabled", true);

	json p = out.contains("place") && out["place"].is_object() ? out["place"] : json::object();
	/* before columns were explicit, `order` carried the column index */
	bool hasCol = p.contains("col") && !p["col"].is_null();
	json place;
	place["row"] = clampInt(numOr(p, "row", 0), 0, 19);
	place["col"] = clampInt(hasCol ? numOr(p, "col", 0) : numOr(p, "order", 0), 0, 19);
	place["order"] = hasCol ? numOr(p, "order", 0) : 0.0;
	place["stretch"] = boolOr(p, "stretch", false);
	place["spanAll"] = boolOr(p, "spanAll", false);
	place["rowSpan"] = clampInt(numOr(p, "rowSpan", 1), 1, 20);
	place["colSpan"] = clampInt(numOr(p, "colSpan", 1), 1, 20);
	if (place["spanAll"].get<bool>()) { place["row"] = 0; place["rowSpan"] = 1; }
	out["place"] = place;

	if (kind == "text") {
		if (!out.contains("text") || !out["text"].is_string())
			out["text"] = "";
		/* saved texts live in st["snippets"], not on the element */
		out.erase("snippets");
		out.erase("image");
	} else {
		out["image"] = deepMerge(base["image"], out.contains("image") ? out["image"] : json::object());
		out.erase("text");
		out.erase("snippets");
	}

	json g = out["style"]["gradient"];
	if (!g.is_object() || !g.contains("stops") || !g["stops"].is_array() || g["stops"].size() < 2) {
		out["style"]["gradient"] = base["style"]["gradient"];
	} else {
		json stops = json::array();
		for (const auto &s : g["stops"]) {
			if (!s.is_object()) continue;
			json o;
			o["color"] = strOr(s, "color", "#ffffff");
			double pos = numOr(s, "pos", 0);
			o["pos"] = pos < 0 ? 0 : (pos > 100 ? 100 : pos);
			double op = numOr(s, "opacity", 1);
			o["opacity"] = op < 0 ? 0 : (op > 1 ? 1 : op);
			stops.push_back(o);
			if (stops.size() >= 24) break;
		}
		if (stops.size() < 2) stops = base["style"]["gradient"]["stops"];
		out["style"]["gradient"]["stops"] = stops;
	}
	return out;
}

/* compact empty rows/columns away, then make the order inside each cell
   sequential - mirrors normalizePlacement() in server.js */
void LtState::normalizePlacement(json &els)
{
	const char *keys[2] = { "row", "col" };
	for (int ki = 0; ki < 2; ki++) {
		const char *key = keys[ki];
		std::vector<int> used;
		for (auto &e : els) {
			int v = e["place"][key].get<int>();
			if (std::find(used.begin(), used.end(), v) == used.end())
				used.push_back(v);
		}
		std::sort(used.begin(), used.end());
		for (auto &e : els) {
			int v = e["place"][key].get<int>();
			int idx = (int)(std::find(used.begin(), used.end(), v) - used.begin());
			e["place"][key] = idx;
		}
	}

	std::map<std::string, std::vector<size_t>> cells;
	for (size_t i = 0; i < els.size(); i++) {
		std::string k = std::to_string(els[i]["place"]["row"].get<int>()) + ":" +
		                std::to_string(els[i]["place"]["col"].get<int>());
		cells[k].push_back(i);
	}
	for (auto &kv : cells) {
		std::vector<size_t> &idxs = kv.second;
		std::sort(idxs.begin(), idxs.end(), [&els](size_t a, size_t b) {
			return els[a]["place"]["order"].get<double>() < els[b]["place"]["order"].get<double>();
		});
		for (size_t n = 0; n < idxs.size(); n++)
			els[idxs[n]]["place"]["order"] = (double)n;
	}
}

/* schema 1 (fixed topline/headline/badge/logo) -> schema 2 (elements).
   Idempotent: an already-migrated look is only normalized. */
json LtState::migrateLook(const json &lookIn)
{
	json look = lookIn.is_object() ? lookIn : json::object();

	if (look.contains("elements") && look["elements"].is_array()) {
		json els = json::array();
		for (const auto &e : look["elements"]) {
			json n = normalizeElement(e);
			if (!n.is_null()) els.push_back(n);
		}
		if (els.empty()) {
			ensureDefaultsLoaded();
			for (const auto &e : g_defaults["look"]["elements"]) {
				json n = normalizeElement(e);
				if (!n.is_null()) els.push_back(n);
			}
		}
		normalizePlacement(els);
		json out;
		out["schema"] = 2;
		out["elements"] = els;
		out["style"] = deepMerge(defaultsStyle(), look.contains("style") ? look["style"] : json::object());
		return out;
	}

	json c = look.contains("content") && look["content"].is_object() ? look["content"] : json::object();
	json st = look.contains("style") && look["style"].is_object() ? look["style"] : json::object();
	json bars = st.contains("bars") && st["bars"].is_object() ? st["bars"] : json::object();
	json lay = st.contains("layout") && st["layout"].is_object() ? st["layout"] : json::object();
	json oldAccent = st.contains("accent") ? st["accent"]
		: json::parse(R"({"mode":"none","color":"#1c56d6","thickness":6})");
	bool logoLeft = lay.contains("logoSide") && lay["logoSide"].is_string() &&
	                lay["logoSide"].get<std::string>() == "left";
	bool fullWidth = boolOr(lay, "fullWidth", true);

	auto styleFrom = [&](const char *kind, const json &barIn, const json &extra) {
		json d = defaultElement(kind)["style"];
		json bar = barIn.is_object() ? barIn : json::object();
		json grad;
		grad["enabled"] = bar.contains("gradient") && bar["gradient"].is_object() &&
			boolOr(bar["gradient"], "enabled", false);
		grad["type"] = "linear";
		grad["angle"] = (bar.contains("gradient") && bar["gradient"].is_object())
			? numOr(bar["gradient"], "angle", 180) : 180.0;
		grad["shape"] = "ellipse";
		grad["posX"] = 50;
		grad["posY"] = 50;
		json stops = json::array();
		json s0;
		s0["color"] = bar.contains("bg") && bar["bg"].is_string() ? bar["bg"] : d["bg"];
		s0["pos"] = 0;
		s0["opacity"] = 1;
		json s1;
		s1["color"] = (bar.contains("gradient") && bar["gradient"].is_object())
			? strOr(bar["gradient"], "color2", "#e9edf5") : json("#e9edf5");
		s1["pos"] = 100;
		s1["opacity"] = 1;
		stops.push_back(s0);
		stops.push_back(s1);
		grad["stops"] = stops;

		json bgImage = d["bgImage"];
		if (bar.contains("image") && bar["image"].is_object()) {
			bgImage["enabled"] = boolOr(bar["image"], "enabled", false);
			bgImage["url"] = strOr(bar["image"], "url", "");
			bgImage["fit"] = strOr(bar["image"], "fit", "cover");
		}

		json mapped = json::object();
		const char *keys[8] = { "bg", "bgOpacity", "color", "size", "weight", "letterSpacing", "padX", "padY" };
		for (int i = 0; i < 8; i++) {
			if (bar.contains(keys[i])) mapped[keys[i]] = bar[keys[i]];
		}
		mapped["gradient"] = grad;
		mapped["bgImage"] = bgImage;
		return deepMerge(deepMerge(d, mapped), extra);
	};

	json els = json::array();

	json topline = defaultElement("text");
	topline["id"] = "el-topline";
	topline["name"] = "Top line";
	topline["enabled"] = c.contains("topline") && boolOr(c["topline"], "enabled", true);
	topline["place"] = json{ { "row", 0 }, { "col", logoLeft ? 1 : 0 }, { "order", 0 },
		{ "stretch", false }, { "spanAll", false }, { "rowSpan", 1 }, { "colSpan", 1 } };
	topline["text"] = c.contains("topline") ? strOr(c["topline"], "text", "") : json("");
	topline["style"] = styleFrom("text", bars.contains("topline") ? bars["topline"] : json::object(), json::object());
	els.push_back(topline);

	json badge = defaultElement("text");
	badge["id"] = "el-badge";
	badge["name"] = "Badge";
	badge["enabled"] = c.contains("badge") && boolOr(c["badge"], "enabled", true);
	badge["place"] = json{ { "row", 0 }, { "col", logoLeft ? 0 : 1 }, { "order", 0 },
		{ "stretch", false }, { "spanAll", false }, { "rowSpan", 1 }, { "colSpan", 1 } };
	badge["text"] = c.contains("badge") ? strOr(c["badge"], "text", "") : json("");
	badge["style"] = styleFrom("text", bars.contains("badge") ? bars["badge"] : json::object(),
		json::parse(R"({"align":"center","nowrap":true,"padX":21,"padY":6})"));
	els.push_back(badge);

	json headline = defaultElement("text");
	headline["id"] = "el-headline";
	headline["name"] = "Headline";
	headline["enabled"] = true;
	headline["place"] = json{ { "row", 1 }, { "col", logoLeft ? 1 : 0 }, { "order", 0 },
		{ "stretch", fullWidth }, { "spanAll", false }, { "rowSpan", 1 }, { "colSpan", 1 } };
	headline["text"] = c.contains("headline") ? strOr(c["headline"], "text", "") : json("");
	{
		json extra = json::object();
		extra["accent"] = oldAccent;
		headline["style"] = styleFrom("text", bars.contains("headline") ? bars["headline"] : json::object(), extra);
	}
	els.push_back(headline);

	json logoBox = bars.contains("logoBox") ? bars["logoBox"] : json::object();
	json logo = defaultElement("image");
	logo["id"] = "el-logo";
	logo["name"] = "Logo";
	logo["enabled"] = c.contains("logo") && boolOr(c["logo"], "enabled", true);
	logo["place"] = json{ { "row", 1 }, { "col", logoLeft ? 0 : 1 }, { "order", 0 },
		{ "stretch", false }, { "spanAll", false }, { "rowSpan", 1 }, { "colSpan", 1 } };
	{
		json img = logo["image"];
		img["url"] = c.contains("logo") ? strOr(c["logo"], "url", "") : json("");
		img["fit"] = "contain";
		img["scale"] = c.contains("logo") ? numOr(c["logo"], "scale", 1) : 1.0;
		logo["image"] = img;
		json bar = json::object();
		if (logoBox.contains("bg")) bar["bg"] = logoBox["bg"];
		if (logoBox.contains("bgOpacity")) bar["bgOpacity"] = logoBox["bgOpacity"];
		if (logoBox.contains("pad")) {
			bar["padX"] = logoBox["pad"];
			bar["padY"] = logoBox["pad"];
		}
		json extra = json::object();
		extra["minWidth"] = logoBox.contains("minWidth") ? logoBox["minWidth"] : json(180);
		extra["align"] = "center";
		logo["style"] = styleFrom("image", bar, extra);
	}
	els.push_back(logo);

	json norm = json::array();
	for (const auto &e : els) {
		json n = normalizeElement(e);
		if (!n.is_null()) norm.push_back(n);
	}
	normalizePlacement(norm);

	json styleOver = json::object();
	styleOver["direction"] = strOr(st, "direction", "auto");
	styleOver["textAlign"] = strOr(st, "textAlign", "start");
	json layout = json::object();
	layout["anchor"] = strOr(lay, "anchor", "left");
	layout["fullWidth"] = fullWidth;
	layout["maxWidth"] = numOr(lay, "maxWidth", 70);
	layout["sideMargin"] = numOr(lay, "sideMargin", 0);
	layout["bottomMargin"] = numOr(lay, "bottomMargin", 64);
	styleOver["layout"] = layout;
	styleOver["gap"] = numOr(st, "gap", 4);
	if (st.contains("font")) styleOver["font"] = st["font"];
	if (st.contains("edges")) styleOver["edges"] = st["edges"];
	styleOver["shadow"] = numOr(st, "shadow", 40);

	json out;
	out["schema"] = 2;
	out["elements"] = norm;
	out["style"] = deepMerge(defaultsStyle(), styleOver);
	return out;
}

json LtState::migratePreset(const json &p)
{
	if (!p.is_object())
		return json();
	json src = json::object();
	if (p.contains("elements") && p["elements"].is_array()) {
		src["elements"] = p["elements"];
		if (p.contains("style")) src["style"] = p["style"];
	} else {
		if (p.contains("content")) src["content"] = p["content"];
		if (p.contains("style")) src["style"] = p["style"];
	}
	json look = migrateLook(src);
	json out;
	out["id"] = (p.contains("id") && p["id"].is_string()) ? p["id"] : json(newId("p"));
	out["name"] = strOr(p, "name", "Preset");
	out["schema"] = 2;
	out["elements"] = look["elements"];
	out["style"] = look["style"];
	out["anim"] = deepMerge(defaultsAnim(), p.contains("anim") ? p["anim"] : json::object());
	return out;
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
	st["snippets"] = json::object();

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
		bool wasOld = saved.contains("live") && saved["live"].is_object() &&
		              !saved["live"].contains("elements");
		if (saved.contains("live"))
			st["live"] = migrateLook(saved["live"]);
		if (saved.contains("pending"))
			st["pending"] = migrateLook(saved["pending"]);
		else if (saved.contains("live"))
			st["pending"] = migrateLook(saved["live"]);
		if (wasOld)
			lt_log("upgraded saved state to the dynamic element model");
		if (saved.contains("anim"))
			st["anim"] = deepMerge(defaultsAnim(), saved["anim"]);
		if (saved.contains("settings"))
			st["settings"] = deepMerge(defaultsSettings(), saved["settings"]);
		st["visible"] = saved.value("visible", false);
		st["shownAt"] = saved.value("shownAt", 0LL);
		if (saved.contains("presets") && saved["presets"].is_array()) {
			json ps = json::array();
			for (const auto &p : saved["presets"]) {
				json m = migratePreset(p);
				if (!m.is_null())
					ps.push_back(m);
			}
			st["presets"] = ps;
		}

		/* saved texts used to hang off each element - lift them into the store */
		json harvested = json::object();
		for (const char *key : { "pending", "live" }) {
			if (!saved.contains(key) || !saved[key].is_object())
				continue;
			const json &look = saved[key];
			if (!look.contains("elements") || !look["elements"].is_array())
				continue;
			for (const auto &e : look["elements"]) {
				if (!e.is_object() || !e.contains("id") || !e["id"].is_string())
					continue;
				std::string eid = e["id"].get<std::string>();
				if (e.contains("snippets") && e["snippets"].is_array() &&
				    !e["snippets"].empty() && !harvested.contains(eid))
					harvested[eid] = e["snippets"];
			}
		}
		if (saved.contains("snippets") && saved["snippets"].is_object()) {
			for (auto it = saved["snippets"].begin(); it != saved["snippets"].end(); ++it)
				harvested[it.key()] = it.value();
		}
		std::vector<std::string> known;
		for (const char *key : { "pending", "live" }) {
			if (!st[key].contains("elements"))
				continue;
			for (const auto &e : st[key]["elements"]) {
				if (e.contains("id") && e["id"].is_string())
					known.push_back(e["id"].get<std::string>());
			}
		}
		st["snippets"] = sanitizeSnippetStore(harvested, &known);
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
	out["snippets"] = st.contains("snippets") ? st["snippets"] : json::object();
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

json *LtState::findElement(const std::string &id)
{
	if (!st["pending"].contains("elements"))
		return nullptr;
	for (auto &e : st["pending"]["elements"]) {
		if (e.contains("id") && e["id"].is_string() && e["id"].get<std::string>() == id)
			return &e;
	}
	return nullptr;
}

json LtState::sanitizeSnippetStore(const json &raw, const std::vector<std::string> *knownIds)
{
	json out = json::object();
	if (!raw.is_object())
		return out;
	size_t buckets = 0;
	for (auto it = raw.begin(); it != raw.end(); ++it) {
		if (buckets >= 64)
			break;
		if (knownIds &&
		    std::find(knownIds->begin(), knownIds->end(), it.key()) == knownIds->end())
			continue;                    /* drop orphans at load time */
		if (!it.value().is_array())
			continue;
		json clean = json::array();
		for (const auto &sn : it.value()) {
			if (!sn.is_object())
				continue;
			json o;
			o["id"] = (sn.contains("id") && sn["id"].is_string()) ? sn["id"] : json(newId("sn"));
			std::string label = sn.contains("label") && sn["label"].is_string()
				? sn["label"].get<std::string>() : std::string();
			std::string text = sn.contains("text") && sn["text"].is_string()
				? sn["text"].get<std::string>() : std::string();
			if (label.size() > 60) label = label.substr(0, 60);
			if (text.size() > 4000) text = text.substr(0, 4000);
			o["label"] = label;
			o["text"] = text;
			clean.push_back(o);
			if (clean.size() >= 60)
				break;
		}
		if (!clean.empty()) {
			out[it.key()] = clean;
			buckets++;
		}
	}
	return out;
}

json &LtState::snippetsForLocked(const std::string &id)
{
	if (!st.contains("snippets") || !st["snippets"].is_object())
		st["snippets"] = json::object();
	if (!st["snippets"].contains(id) || !st["snippets"][id].is_array())
		st["snippets"][id] = json::array();
	return st["snippets"][id];
}

void LtState::pushSnippetsLocked()
{
	scheduleSaveLocked();
	broadcastJson({{"type", "snippets"}, {"snippets", st["snippets"]}});
}

void LtState::pushPendingLocked()
{
	scheduleSaveLocked();
	broadcastJson({{"type", "pending"}, {"pending", st["pending"]}, {"dirty", isDirtyLocked()}});
}

/* map a legacy role name (headline/topline/badge/logo) onto a live element */
static json *elementByRole(json &els, const std::string &role)
{
	for (auto &e : els) {
		if (e.value("id", "") == "el-" + role)
			return &e;
	}
	for (auto &e : els) {
		std::string n = e.value("name", "");
		std::string flat;
		for (char ch : n) {
			if (!isspace((unsigned char)ch))
				flat += (char)tolower((unsigned char)ch);
		}
		if (flat == role)
			return &e;
	}
	if (role == "headline") {
		json *best = nullptr;
		double bestSize = -1;
		for (auto &e : els) {
			if (e.value("kind", "") != "text")
				continue;
			double sz = e["style"].value("size", 0.0);
			if (sz > bestSize) { bestSize = sz; best = &e; }
		}
		return best;
	}
	return nullptr;
}

void LtState::applyEdit(const json &patch)
{
	std::lock_guard<std::recursive_mutex> lk(mtx);
	json p = sanitize(patch);
	if (!p.is_object())
		p = json::object();

	/* legacy shape { content: { headline: { text } } } from older scripts and
	   the /api/pending query helpers - route it to the matching element */
	if (p.contains("content") && p["content"].is_object()) {
		for (auto it = p["content"].begin(); it != p["content"].end(); ++it) {
			json *e = elementByRole(st["pending"]["elements"], it.key());
			if (!e)
				continue;
			if (it.value().is_object() && it.value().contains("text") && it.value()["text"].is_string())
				(*e)["text"] = it.value()["text"];
			if (it.value().is_object() && it.value().contains("enabled") && it.value()["enabled"].is_boolean())
				(*e)["enabled"] = it.value()["enabled"];
		}
		p.erase("content");
	}
	if (p.contains("elements") && p["elements"].is_array()) {
		json els = json::array();
		for (const auto &e : p["elements"]) {
			json n = normalizeElement(e);
			if (!n.is_null())
				els.push_back(n);
		}
		normalizePlacement(els);
		st["pending"]["elements"] = els;
		p.erase("elements");
	}
	st["pending"] = deepMerge(st["pending"], p);
	pushPendingLocked();
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
		st["pending"]["style"] = defaultsStyle();
		scheduleSaveLocked();
		broadcastJson({{"type", "pending"}, {"pending", st["pending"]}, {"dirty", isDirtyLocked()}});
	}
	/* ---- dynamic elements ---- */
	else if (t == "element-add") {
		std::string kind = msg.value("kind", "text") == "image" ? "image" : "text";
		json e = defaultElement(kind.c_str());
		e["id"] = newId("el");
		if (msg.contains("name") && msg["name"].is_string())
			e["name"] = msg["name"];
		json place = e["place"];
		place["row"] = msg.contains("row") && msg["row"].is_number() ? (int)msg["row"].get<double>() : 0;
		place["col"] = msg.contains("col") && msg["col"].is_number() ? (int)msg["col"].get<double>() : 0;
		place["order"] = 999.0;
		e["place"] = place;
		json n = normalizeElement(e);
		if (!n.is_null()) {
			st["pending"]["elements"].push_back(n);
			normalizePlacement(st["pending"]["elements"]);
			pushPendingLocked();
		}
	} else if (t == "element-remove") {
		std::string id = msg.value("id", "");
		json keep = json::array();
		for (const auto &e : st["pending"]["elements"]) {
			if (e.value("id", "") != id)
				keep.push_back(e);
		}
		if (keep.empty()) {
			json e = defaultElement("text");
			e["id"] = newId("el");
			e["name"] = "Headline";
			json n = normalizeElement(e);
			if (!n.is_null())
				keep.push_back(n);
		}
		st["pending"]["elements"] = keep;
		normalizePlacement(st["pending"]["elements"]);
		pushPendingLocked();
	} else if (t == "element-duplicate") {
		json *src = findElement(msg.value("id", ""));
		if (src) {
			json copy = *src;
			copy["id"] = newId("el");
			copy["name"] = copy.value("name", std::string("Element")) + " copy";
			copy["place"]["order"] = copy["place"].value("order", 0.0) + 0.5;
			json n = normalizeElement(copy);
			if (!n.is_null()) {
				st["pending"]["elements"].push_back(n);
				normalizePlacement(st["pending"]["elements"]);
				pushPendingLocked();
			}
		}
	} else if (t == "element-update") {
		std::string id = msg.value("id", "");
		json *e = findElement(id);
		if (e) {
			json merged = deepMerge(*e, sanitize(msg.contains("patch") ? msg["patch"] : json::object()));
			merged["id"] = (*e)["id"];        /* a patch can never change identity */
			merged["kind"] = (*e)["kind"];
			json n = normalizeElement(merged);
			if (!n.is_null()) {
				*e = n;
				normalizePlacement(st["pending"]["elements"]);
				pushPendingLocked();
			}
		}
	} else if (t == "element-move") {
		json *e = findElement(msg.value("id", ""));
		if (e) {
			std::string dir = msg.value("dir", "");
			json &pl = (*e)["place"];
			if (dir == "up") pl["row"] = pl["row"].get<int>() - 1;
			else if (dir == "down") pl["row"] = pl["row"].get<int>() + 1;
			else if (dir == "left") pl["col"] = pl["col"].get<int>() - 1;
			else if (dir == "right") pl["col"] = pl["col"].get<int>() + 1;
			else if (dir == "first") pl["order"] = pl["order"].get<double>() - 1.5;
			else if (dir == "last") pl["order"] = pl["order"].get<double>() + 1.5;

			std::string movedId = (*e).value("id", "");
			if (pl["row"].get<int>() < 0) {
				for (auto &o : st["pending"]["elements"]) {
					if (o.value("id", "") != movedId)
						o["place"]["row"] = o["place"]["row"].get<int>() + 1;
				}
				json *me = findElement(movedId);
				if (me) (*me)["place"]["row"] = 0;
			}
			json *me2 = findElement(movedId);
			if (me2 && (*me2)["place"]["col"].get<int>() < 0) {
				for (auto &o : st["pending"]["elements"]) {
					if (o.value("id", "") != movedId)
						o["place"]["col"] = o["place"]["col"].get<int>() + 1;
				}
				json *me3 = findElement(movedId);
				if (me3) (*me3)["place"]["col"] = 0;
			}
			normalizePlacement(st["pending"]["elements"]);
			pushPendingLocked();
		}
	} else if (t == "element-newrow") {
		json *e = findElement(msg.value("id", ""));
		if (e) {
			std::string movedId = (*e).value("id", "");
			int target = (*e)["place"]["row"].get<int>() + 1;
			for (auto &o : st["pending"]["elements"]) {
				if (o.value("id", "") != movedId && o["place"]["row"].get<int>() >= target)
					o["place"]["row"] = o["place"]["row"].get<int>() + 1;
			}
			json *me = findElement(movedId);
			if (me) {
				(*me)["place"]["row"] = target;
				(*me)["place"]["col"] = 0;
				(*me)["place"]["order"] = 0.0;
			}
			normalizePlacement(st["pending"]["elements"]);
			pushPendingLocked();
		}
	}

	/* ---- saved texts (a library, kept out of live/pending on purpose) ---- */
	else if (t == "snippet-save") {
		json *e = findElement(msg.value("id", ""));
		if (e && (*e).value("kind", "") == "text") {
			std::string text = msg.contains("text") && msg["text"].is_string()
				? msg["text"].get<std::string>() : (*e).value("text", "");
			bool blank = text.find_first_not_of(" \t\r\n") == std::string::npos;
			if (!blank) {
				std::string label = msg.contains("label") && msg["label"].is_string()
					? msg["label"].get<std::string>() : text;
				if (label.size() > 60) label = label.substr(0, 60);
				if (text.size() > 4000) text = text.substr(0, 4000);
				std::string eid = (*e).value("id", "");
				json &list = snippetsForLocked(eid);
				json sn;
				sn["id"] = newId("sn");
				sn["label"] = label;
				sn["text"] = text;
				list.push_back(sn);
				while (list.size() > 60)
					list.erase(list.begin());
				pushSnippetsLocked();
			}
		}
	} else if (t == "snippet-load") {
		/* fills PENDING only - never shows or takes on its own */
		json *e = findElement(msg.value("id", ""));
		std::string eid = msg.value("id", "");
		std::string sid = msg.value("snippetId", "");
		if (e && (*e).value("kind", "") == "text" && st.contains("snippets") &&
		    st["snippets"].contains(eid) && st["snippets"][eid].is_array()) {
			for (const auto &sn : st["snippets"][eid]) {
				if (sn.value("id", "") == sid) {
					(*e)["text"] = sn.value("text", "");
					pushPendingLocked();
					break;
				}
			}
		}
	} else if (t == "snippet-delete") {
		std::string eid = msg.value("id", "");
		std::string sid = msg.value("snippetId", "");
		if (st.contains("snippets") && st["snippets"].contains(eid) &&
		    st["snippets"][eid].is_array()) {
			json keep = json::array();
			for (const auto &sn : st["snippets"][eid]) {
				if (sn.value("id", "") != sid)
					keep.push_back(sn);
			}
			st["snippets"][eid] = keep;
			pushSnippetsLocked();
		}
	} else if (t == "snippet-rename") {
		std::string eid = msg.value("id", "");
		std::string sid = msg.value("snippetId", "");
		if (st.contains("snippets") && st["snippets"].contains(eid) &&
		    st["snippets"][eid].is_array()) {
			for (auto &sn : st["snippets"][eid]) {
				if (sn.value("id", "") == sid) {
					std::string lbl = msg.value("label", sn.value("label", ""));
					if (lbl.size() > 60) lbl = lbl.substr(0, 60);
					sn["label"] = lbl;
					pushSnippetsLocked();
					break;
				}
			}
		}
	}
	else if (t == "preset-save") {
		std::string name = msg.value("name", "Preset");
		if (name.size() > 60)
			name.resize(60);
		json p = {{"id", newId("p")},
			  {"name", name},
			  {"schema", 2},
			  {"elements", st["pending"]["elements"]},
			  {"style", st["pending"]["style"]},
			  {"anim", st["anim"]}};
		st["presets"].push_back(migratePreset(p));
		scheduleSaveLocked();
		broadcastJson({{"type", "presets"}, {"presets", st["presets"]}});
	} else if (t == "preset-update") {
		std::string id = msg.value("id", "");
		for (auto &p : st["presets"]) {
			if (p.value("id", "") == id) {
				p["elements"] = st["pending"]["elements"];
				p["style"] = st["pending"]["style"];
				p["anim"] = st["anim"];
				p["schema"] = 2;
				p.erase("content");
				break;
			}
		}
		scheduleSaveLocked();
		broadcastJson({{"type", "presets"}, {"presets", st["presets"]}});
	} else if (t == "preset-load") {
		std::string id = msg.value("id", "");
		for (const auto &p : st["presets"]) {
			if (p.value("id", "") == id) {
				json look = migratePreset(p);
				st["pending"]["elements"] = look["elements"];
				st["pending"]["style"] = look["style"];
				st["pending"]["schema"] = 2;
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
