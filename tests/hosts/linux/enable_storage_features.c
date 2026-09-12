/* Test-only dynamic interposition around the public WebView settings getter.
 * This measures five explicit public feature settings in the real Tauri
 * host before any production host change. It is never linked into the app.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <webkit2/webkit2.h>

WebKitSettings *webkit_web_view_get_settings(WebKitWebView *view) {
    static WebKitSettings *(*original)(WebKitWebView *);
    if (!original) {
        original = dlsym(RTLD_NEXT, "webkit_web_view_get_settings");
        if (!original) abort();
    }
    WebKitSettings *settings = original(view);
    if (!settings || g_object_get_data(G_OBJECT(settings), "quixi-proof-storage-enabled")) return settings;
    g_object_set_data(G_OBJECT(settings), "quixi-proof-storage-enabled", GINT_TO_POINTER(1));
    WebKitFeatureList *features = webkit_settings_get_all_features();
    unsigned enabled = 0;
    for (gsize i = 0; i < webkit_feature_list_get_length(features); ++i) {
        WebKitFeature *feature = webkit_feature_list_get(features, i);
        const char *id = webkit_feature_get_identifier(feature);
        if (strcmp(id, "AccessHandle") && strcmp(id, "FileSystem") && strcmp(id, "FileSystemWritableStream") &&
            strcmp(id, "StorageAPI") && strcmp(id, "StorageAPIEstimate")) continue;
        WebKitFeatureStatus status = webkit_feature_get_status(feature);
        if (status != WEBKIT_FEATURE_STATUS_STABLE && status != WEBKIT_FEATURE_STATUS_MATURE) abort();
        webkit_settings_set_feature_enabled(settings, feature, TRUE);
        if (!webkit_settings_get_feature_enabled(settings, feature)) abort();
        fprintf(stderr, "QUIXI_TEST_FEATURE_ENABLED=%s\n", id);
        enabled++;
    }
    webkit_feature_list_unref(features);
    if (enabled != 5) abort();
    return settings;
}
