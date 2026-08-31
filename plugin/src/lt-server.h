#pragma once

#include <map>
#include <mutex>
#include <string>

#include "json.hpp"

struct mg_context;
struct mg_connection;
class LtState;

/* Embedded HTTP + WebSocket server (civetweb) serving the overlay and the
 * control panel, speaking the same protocol as the Node server. */
class LtServer {
public:
	bool start(int port, const std::string &webRoot, const std::string &uploadDir, LtState *state);
	void stop();
	bool running() const { return ctx != nullptr; }

	void broadcastText(const std::string &text, const char *roleFilter);
	nlohmann::json countsJson();

private:
	static int wsConnect(const struct mg_connection *conn, void *cbdata);
	static void wsReady(struct mg_connection *conn, void *cbdata);
	static int wsData(struct mg_connection *conn, int bits, char *data, size_t len, void *cbdata);
	static void wsClose(const struct mg_connection *conn, void *cbdata);

	static int apiHandler(struct mg_connection *conn, void *cbdata);
	static int overlayHandler(struct mg_connection *conn, void *cbdata);
	static int controlHandler(struct mg_connection *conn, void *cbdata);
	static int rootHandler(struct mg_connection *conn, void *cbdata);
	static int uploadsHandler(struct mg_connection *conn, void *cbdata);

	void sendCounts();

	struct mg_context *ctx = nullptr;
	LtState *state = nullptr;
	std::string webRoot;
	std::string uploadDir;

	std::mutex cmtx;
	std::map<struct mg_connection *, std::string> clients; /* conn -> role */
};
