#include "lt-server.h"
#include "lt-state.h"

#include <cctype>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <random>
#include <set>
#include <sstream>
#include <vector>

#include "civetweb.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

using nlohmann::json;
namespace fs = std::filesystem;

extern void lt_log(const char *fmt, ...);

/* ----------------------------------------------------------- helpers */

static std::string url_decode(const std::string &in)
{
	std::vector<char> buf(in.size() + 1);
	int n = mg_url_decode(in.c_str(), (int)in.size(), buf.data(), (int)buf.size(), 1);
	if (n < 0)
		return in;
	return std::string(buf.data(), (size_t)n);
}

static std::map<std::string, std::string> parse_query(const char *qs)
{
	std::map<std::string, std::string> out;
	if (!qs)
		return out;
	std::stringstream ss(qs);
	std::string pair;
	while (std::getline(ss, pair, '&')) {
		size_t eq = pair.find('=');
		if (eq == std::string::npos)
			out[url_decode(pair)] = "";
		else
			out[url_decode(pair.substr(0, eq))] = url_decode(pair.substr(eq + 1));
	}
	return out;
}

static void send_json(struct mg_connection *conn, int code, const json &obj)
{
	std::string body = obj.dump();
	mg_printf(conn,
		  "HTTP/1.1 %d %s\r\n"
		  "Content-Type: application/json; charset=utf-8\r\n"
		  "Content-Length: %u\r\n"
		  "Cache-Control: no-store\r\n"
		  "Access-Control-Allow-Origin: *\r\n"
		  "Connection: close\r\n\r\n",
		  code, code == 200 ? "OK" : "Error", (unsigned)body.size());
	mg_write(conn, body.data(), body.size());
}

/* enumerate installed font families (Windows GDI); cached after first call */
#ifdef _WIN32
static int CALLBACK font_enum_proc(const LOGFONTW *lf, const TEXTMETRICW *, DWORD, LPARAM p)
{
	auto *out = (std::set<std::wstring> *)p;
	if (lf->lfFaceName[0] && lf->lfFaceName[0] != L'@')
		out->insert(lf->lfFaceName);
	return 1;
}
#endif

static const std::vector<std::string> &system_fonts()
{
	static std::vector<std::string> cache;
	static bool loaded = false;
	static std::mutex m;
	std::lock_guard<std::mutex> lk(m);
	if (loaded)
		return cache;
	loaded = true;
#ifdef _WIN32
	std::set<std::wstring> names;
	LOGFONTW lf = {};
	lf.lfCharSet = DEFAULT_CHARSET;
	HDC dc = GetDC(nullptr);
	if (dc) {
		EnumFontFamiliesExW(dc, &lf, font_enum_proc, (LPARAM)&names, 0);
		ReleaseDC(nullptr, dc);
	}
	for (const auto &w : names) {
		int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
		if (len <= 1)
			continue;
		std::string s(len - 1, '\0');
		WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, &s[0], len, nullptr, nullptr);
		cache.push_back(s);
	}
#endif
	return cache;
}

static std::string read_body(struct mg_connection *conn, size_t limit)
{
	std::string out;
	char buf[8192];
	for (;;) {
		int n = mg_read(conn, buf, sizeof(buf));
		if (n <= 0)
			break;
		out.append(buf, (size_t)n);
		if (out.size() > limit)
			break;
	}
	return out;
}

/* ------------------------------------------------------------- start */

bool LtServer::start(int port, const std::string &root, const std::string &uploads, LtState *st)
{
	state = st;
	webRoot = root;
	uploadDir = uploads;

	static bool libInit = false;
	if (!libInit) {
		mg_init_library(0);
		libInit = true;
	}

	char portstr[64];
	snprintf(portstr, sizeof(portstr), "127.0.0.1:%d", port);

	const char *options[] = {
		"listening_ports", portstr,
		"document_root", webRoot.c_str(),
		"num_threads", "8",
		"enable_directory_listing", "no",
		"static_file_max_age", "0",
		"websocket_timeout_ms", "86400000",
		nullptr,
	};

	struct mg_callbacks callbacks;
	memset(&callbacks, 0, sizeof(callbacks));

	ctx = mg_start(&callbacks, this, options);
	if (!ctx)
		return false;

	mg_set_request_handler(ctx, "/api/", apiHandler, this);
	mg_set_request_handler(ctx, "/overlay$", overlayHandler, this);
	mg_set_request_handler(ctx, "/control$", controlHandler, this);
	mg_set_request_handler(ctx, "/$", rootHandler, this);
	mg_set_request_handler(ctx, "/uploads/", uploadsHandler, this);
	mg_set_websocket_handler(ctx, "/ws$", wsConnect, wsReady, wsData, wsClose, this);
	return true;
}

void LtServer::stop()
{
	if (ctx) {
		mg_stop(ctx);
		ctx = nullptr;
	}
	std::lock_guard<std::mutex> lk(cmtx);
	clients.clear();
}

/* -------------------------------------------------------------- hub */

nlohmann::json LtServer::countsJson()
{
	int program = 0, preview = 0, control = 0;
	{
		std::lock_guard<std::mutex> lk(cmtx);
		for (auto &c : clients) {
			if (c.second == "program")
				program++;
			else if (c.second == "preview")
				preview++;
			else
				control++;
		}
	}
	return json{{"program", program}, {"preview", preview}, {"control", control}};
}

void LtServer::broadcastText(const std::string &text, const char *roleFilter)
{
	std::lock_guard<std::mutex> lk(cmtx);
	for (auto &c : clients) {
		if (roleFilter && c.second != roleFilter)
			continue;
		mg_lock_connection(c.first);
		mg_websocket_write(c.first, MG_WEBSOCKET_OPCODE_TEXT, text.c_str(), text.size());
		mg_unlock_connection(c.first);
	}
}

void LtServer::sendCounts()
{
	json msg = {{"type", "counts"}, {"counts", countsJson()}};
	broadcastText(msg.dump(), nullptr);
}

int LtServer::wsConnect(const struct mg_connection *conn, void *cbdata)
{
	(void)cbdata;
	const struct mg_request_info *ri = mg_get_request_info(conn);
	auto params = parse_query(ri ? ri->query_string : nullptr);
	std::string role = params.count("role") ? params["role"] : "control";
	if (role != "program" && role != "preview" && role != "control")
		role = "control";
	auto *roleStr = new std::string(role);
	mg_set_user_connection_data((struct mg_connection *)conn, roleStr);
	return 0; /* accept */
}

void LtServer::wsReady(struct mg_connection *conn, void *cbdata)
{
	auto *self = (LtServer *)cbdata;
	auto *roleStr = (std::string *)mg_get_user_connection_data(conn);
	std::string role = roleStr ? *roleStr : "control";

	std::string hello = self->state->helloText(self->countsJson());
	{
		std::lock_guard<std::mutex> lk(self->cmtx);
		self->clients[conn] = role;
		mg_lock_connection(conn);
		mg_websocket_write(conn, MG_WEBSOCKET_OPCODE_TEXT, hello.c_str(), hello.size());
		mg_unlock_connection(conn);
	}
	self->sendCounts();
}

int LtServer::wsData(struct mg_connection *conn, int bits, char *data, size_t len, void *cbdata)
{
	auto *self = (LtServer *)cbdata;
	int opcode = bits & 0x0F;
	if (opcode == MG_WEBSOCKET_OPCODE_CONNECTION_CLOSE)
		return 0;
	if (opcode == MG_WEBSOCKET_OPCODE_TEXT) {
		try {
			json msg = json::parse(std::string(data, len));
			self->state->handleClientMessage(msg);
		} catch (const std::exception &e) {
			lt_log("bad ws message: %s", e.what());
		}
	}
	return 1; /* keep open */
}

void LtServer::wsClose(const struct mg_connection *conn, void *cbdata)
{
	auto *self = (LtServer *)cbdata;
	auto *roleStr = (std::string *)mg_get_user_connection_data(conn);
	delete roleStr;
	{
		std::lock_guard<std::mutex> lk(self->cmtx);
		self->clients.erase((struct mg_connection *)conn);
	}
	self->sendCounts();
}

/* ------------------------------------------------------------- pages */

int LtServer::overlayHandler(struct mg_connection *conn, void *cbdata)
{
	auto *self = (LtServer *)cbdata;
	fs::path f = fs::path(self->webRoot) / "overlay.html";
	mg_send_mime_file(conn, f.string().c_str(), "text/html; charset=utf-8");
	return 200;
}

int LtServer::controlHandler(struct mg_connection *conn, void *cbdata)
{
	auto *self = (LtServer *)cbdata;
	fs::path f = fs::path(self->webRoot) / "control.html";
	mg_send_mime_file(conn, f.string().c_str(), "text/html; charset=utf-8");
	return 200;
}

int LtServer::rootHandler(struct mg_connection *conn, void *cbdata)
{
	(void)cbdata;
	mg_send_http_redirect(conn, "/control", 302);
	return 302;
}

int LtServer::uploadsHandler(struct mg_connection *conn, void *cbdata)
{
	auto *self = (LtServer *)cbdata;
	const struct mg_request_info *ri = mg_get_request_info(conn);
	std::string uri = ri->local_uri ? ri->local_uri : "";
	std::string name = uri.substr(std::string("/uploads/").size());
	if (name.empty() || name.find("..") != std::string::npos ||
	    name.find('/') != std::string::npos || name.find('\\') != std::string::npos) {
		send_json(conn, 403, {{"ok", false}, {"error", "forbidden"}});
		return 403;
	}
	const char *mime = nullptr;
	size_t dot = name.find_last_of('.');
	if (dot != std::string::npos) {
		std::string ext = name.substr(dot + 1);
		for (auto &c : ext)
			c = (char)tolower((unsigned char)c);
		if (ext == "woff2") mime = "font/woff2";
		else if (ext == "woff") mime = "font/woff";
		else if (ext == "ttf") mime = "font/ttf";
		else if (ext == "otf") mime = "font/otf";
	}
	fs::path f = fs::path(self->uploadDir) / name;
	mg_send_mime_file(conn, f.string().c_str(), mime);
	return 200;
}

/* --------------------------------------------------------------- api */

int LtServer::apiHandler(struct mg_connection *conn, void *cbdata)
{
	auto *self = (LtServer *)cbdata;
	LtState *st = self->state;
	const struct mg_request_info *ri = mg_get_request_info(conn);
	std::string uri = ri->local_uri ? ri->local_uri : "";
	std::string act = uri.substr(std::string("/api/").size());
	std::string method = ri->request_method ? ri->request_method : "GET";
	auto params = parse_query(ri->query_string);

	if (act == "state") {
		json out = st->publicState();
		out["obs"] = st->obsStatusPayload();
		send_json(conn, 200, out);
		return 200;
	}

	if (act == "fonts") {
		send_json(conn, 200, {{"ok", true}, {"fonts", system_fonts()}});
		return 200;
	}

	if (act == "take" || act == "show" || act == "hide" || act == "toggle" || act == "revert") {
		if (act == "take")
			st->take("api");
		else if (act == "show")
			st->show("api");
		else if (act == "hide")
			st->hide("api");
		else if (act == "toggle")
			st->toggleVisible("api");
		else
			st->revert();
		json s = st->publicState();
		send_json(conn, 200, {{"ok", true}, {"visible", s["visible"]}, {"dirty", s["dirty"]}});
		return 200;
	}

	if (act == "pending") {
		json patch = json::object();
		if (method == "POST") {
			std::string body = read_body(conn, 1024 * 1024);
			if (!body.empty()) {
				try {
					patch = json::parse(body);
				} catch (const std::exception &) {
					send_json(conn, 400, {{"ok", false}, {"error", "Invalid JSON body"}});
					return 400;
				}
			}
		}
		json content = json::object();
		if (params.count("headline"))
			content["headline"] = {{"text", params["headline"]}};
		if (params.count("topline"))
			content["topline"] = {{"text", params["topline"]}, {"enabled", true}};
		if (params.count("badge"))
			content["badge"] = {{"text", params["badge"]}, {"enabled", true}};
		if (!content.empty()) {
			if (!patch.contains("content"))
				patch["content"] = json::object();
			for (auto it = content.begin(); it != content.end(); ++it)
				patch["content"][it.key()] = it.value();
		}
		st->applyEdit(patch);
		if (params.count("take") && params["take"] == "1")
			st->take("api");
		if (params.count("show") && params["show"] == "1")
			st->show("api");
		json s = st->publicState();
		send_json(conn, 200, {{"ok", true}, {"dirty", s["dirty"]}});
		return 200;
	}

	if (act == "upload" && method == "POST") {
		std::string body = read_body(conn, 20 * 1024 * 1024 + 1);
		if (body.size() > 20 * 1024 * 1024) {
			send_json(conn, 400, {{"ok", false}, {"error", "Body too large"}});
			return 400;
		}
		std::string rawName = params.count("name") ? params["name"] : "upload.png";
		std::string ext = "png";
		size_t dot = rawName.find_last_of('.');
		if (dot != std::string::npos) {
			ext = rawName.substr(dot + 1);
			for (auto &c : ext)
				c = (char)tolower((unsigned char)c);
		}
		bool isImg = (ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "gif" ||
			      ext == "webp" || ext == "svg");
		bool isFont = (ext == "ttf" || ext == "otf" || ext == "woff" || ext == "woff2");
		if (!isImg && !isFont)
			ext = "png";
		static std::mt19937_64 rng((uint64_t)std::chrono::steady_clock::now().time_since_epoch().count());
		std::ostringstream nm;
		nm << (isFont ? "font-" : "logo-") << std::hex << (rng() & 0xffffffffULL) << "." << ext;
		try {
			fs::create_directories(self->uploadDir);
			fs::path f = fs::path(self->uploadDir) / nm.str();
			std::ofstream out(f, std::ios::binary | std::ios::trunc);
			out.write(body.data(), (std::streamsize)body.size());
		} catch (const std::exception &e) {
			send_json(conn, 500, {{"ok", false}, {"error", e.what()}});
			return 500;
		}
		send_json(conn, 200, {{"ok", true}, {"url", std::string("/uploads/") + nm.str()}});
		return 200;
	}

	if (act == "quit") {
		send_json(conn, 200, {{"ok", false}, {"error", "The server is managed by the OBS plugin; it stops with OBS."}});
		return 200;
	}

	send_json(conn, 404, {{"ok", false}, {"error", "Unknown API endpoint"}});
	return 404;
}
