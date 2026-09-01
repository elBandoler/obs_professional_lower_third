/* "Lower Third" source — a thin wrapper around OBS's browser source pointed
 * at the plugin's own overlay URL, so users just add the source with no
 * URL copying.
 *
 * There is deliberately NO preview role here. A source lives in a scene, and
 * any scene can be transitioned to program, so a source that renders pending
 * edits is a way to put unfinished text on air, not a preview. The preview
 * lives in the dock (which can never reach air); for a bigger one, open
 * /overlay?role=preview in an ordinary browser window outside OBS. */

#include <obs-module.h>
#include <cstdio>
#include <cstring>

extern int lt_server_port(void); /* provided by plugin-main */

struct lt_source {
	obs_source_t *self;
	obs_source_t *child;
};

static const char *lt_src_get_name(void *)
{
	return "Lower Third";
}

static void lt_src_apply(struct lt_source *s, obs_data_t *settings)
{
	char url[256];
	snprintf(url, sizeof(url), "http://127.0.0.1:%d/overlay", lt_server_port());

	obs_data_t *cs = obs_data_create();
	obs_data_set_string(cs, "url", url);
	obs_data_set_int(cs, "width", 1920);
	obs_data_set_int(cs, "height", 1080);
	obs_data_set_bool(cs, "shutdown", false);
	obs_data_set_bool(cs, "restart_when_active", false);
	obs_data_set_bool(cs, "fps_custom", false);

	if (!s->child) {
		s->child = obs_source_create_private("browser_source", "lowerthird-overlay", cs);
		if (!s->child)
			blog(LOG_WARNING, "[obs-lowerthirds] browser_source unavailable — is the obs-browser plugin present?");
	} else {
		obs_source_update(s->child, cs);
	}
	obs_data_release(cs);
}

static void *lt_src_create(obs_data_t *settings, obs_source_t *source)
{
	auto *s = (struct lt_source *)bzalloc(sizeof(struct lt_source));
	s->self = source;
	s->child = nullptr;
	lt_src_apply(s, settings);
	return s;
}

static void lt_src_destroy(void *data)
{
	auto *s = (struct lt_source *)data;
	if (s->child)
		obs_source_release(s->child);
	bfree(s);
}

static void lt_src_update(void *data, obs_data_t *settings)
{
	lt_src_apply((struct lt_source *)data, settings);
}

static void lt_src_video_render(void *data, gs_effect_t *)
{
	auto *s = (struct lt_source *)data;
	if (s->child)
		obs_source_video_render(s->child);
}

static uint32_t lt_src_get_width(void *data)
{
	auto *s = (struct lt_source *)data;
	return s->child ? obs_source_get_width(s->child) : 1920;
}

static uint32_t lt_src_get_height(void *data)
{
	auto *s = (struct lt_source *)data;
	return s->child ? obs_source_get_height(s->child) : 1080;
}

static void lt_src_show(void *data)
{
	auto *s = (struct lt_source *)data;
	if (s->child)
		obs_source_inc_showing(s->child);
}

static void lt_src_hide(void *data)
{
	auto *s = (struct lt_source *)data;
	if (s->child)
		obs_source_dec_showing(s->child);
}

static void lt_src_activate(void *data)
{
	auto *s = (struct lt_source *)data;
	if (s->child)
		obs_source_inc_active(s->child);
}

static void lt_src_deactivate(void *data)
{
	auto *s = (struct lt_source *)data;
	if (s->child)
		obs_source_dec_active(s->child);
}

static void lt_src_enum_active(void *data, obs_source_enum_proc_t enum_callback, void *param)
{
	auto *s = (struct lt_source *)data;
	if (s->child)
		enum_callback(s->self, s->child, param);
}

static obs_properties_t *lt_src_properties(void *)
{
	obs_properties_t *props = obs_properties_create();
	obs_properties_add_text(props, "lt_note",
		"This source shows what is on air.\n\n"
		"Edit in the Lower Thirds dock and press SHOW to put changes on air.",
		OBS_TEXT_INFO);
	return props;
}

static void lt_src_defaults(obs_data_t *settings)
{
	/* a source saved by an older build may still carry role=preview; it is
	   ignored now, so such a source quietly becomes a normal program one */
	obs_data_set_default_string(settings, "role", "program");
}

void lt_register_source(void)
{
	static struct obs_source_info info = {};
	info.id = "lowerthird_source";
	info.type = OBS_SOURCE_TYPE_INPUT;
	info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_DO_NOT_DUPLICATE;
	info.get_name = lt_src_get_name;
	info.create = lt_src_create;
	info.destroy = lt_src_destroy;
	info.update = lt_src_update;
	info.video_render = lt_src_video_render;
	info.get_width = lt_src_get_width;
	info.get_height = lt_src_get_height;
	info.show = lt_src_show;
	info.hide = lt_src_hide;
	info.activate = lt_src_activate;
	info.deactivate = lt_src_deactivate;
	info.enum_active_sources = lt_src_enum_active;
	info.get_properties = lt_src_properties;
	info.get_defaults = lt_src_defaults;
	info.icon_type = OBS_ICON_TYPE_BROWSER;
	obs_register_source(&info);
}
