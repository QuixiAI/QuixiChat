/* Inspect public WebKitGTK feature settings; no WebView or persistence substitute. */
#include <stdio.h>
#include <string.h>
#include <webkit2/webkit2.h>

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);
    WebKitSettings *settings = webkit_settings_new();
    WebKitFeatureList *features = webkit_settings_get_all_features();
    const char *statuses[] = {"embedder", "unstable", "internal", "developer", "testable", "preview", "stable", "mature"};
    puts("[");
    int first = 1;
    for (gsize i = 0; i < webkit_feature_list_get_length(features); ++i) {
        WebKitFeature *feature = webkit_feature_list_get(features, i);
        const char *id = webkit_feature_get_identifier(feature);
        if (!strstr(id, "Storage") && !strstr(id, "FileSystem") && !strstr(id, "AccessHandle")) continue;
        int before = webkit_settings_get_feature_enabled(settings, feature);
        webkit_settings_set_feature_enabled(settings, feature, TRUE);
        int after = webkit_settings_get_feature_enabled(settings, feature);
        webkit_settings_set_feature_enabled(settings, feature, before);
        unsigned status = webkit_feature_get_status(feature);
        printf("%s{\"id\":\"%s\",\"status\":\"%s\",\"default\":%s,\"before\":%s,\"afterEnable\":%s}",
            first ? "" : ",\n", id, status < 8 ? statuses[status] : "unknown",
            webkit_feature_get_default_value(feature) ? "true" : "false", before ? "true" : "false", after ? "true" : "false");
        first = 0;
    }
    puts("\n]");
    webkit_feature_list_unref(features);
    g_object_unref(settings);
    return 0;
}
