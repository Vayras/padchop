#include "PluginEditor.h"

#import <AppKit/AppKit.h>

namespace padchop::plugin {

namespace {

void unregisterDrops(NSView* view) {
    if (view.registeredDraggedTypes.count > 0) [view unregisterDraggedTypes];
    for (NSView* child in view.subviews) unregisterDrops(child);
}

} // namespace

// WKWebView registers itself (and its subviews) as a drag destination, and a
// page only ever sees a dropped file's bytes, never its path. With those views
// unregistered, AppKit hands the drag to the editor's own view, where JUCE
// delivers it to Editor::filesDropped with real file paths.
void routeWebViewDropsToEditor(juce::Component& web) {
    std::function<void(juce::Component&)> visit = [&](juce::Component& c) {
        if (auto* host = dynamic_cast<juce::NSViewComponent*>(&c))
            if (auto* view = static_cast<NSView*>(host->getView())) unregisterDrops(view);
        for (auto* child : c.getChildren()) visit(*child);
    };
    visit(web);
}

} // namespace padchop::plugin
