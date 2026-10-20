#!/bin/sh
# Builds the web UI, then the plugin (VST3, AU, Standalone; AUv3 with --auv3).
# The build lives outside iCloud-synced folders: their extended attributes
# make codesign fail ("resource fork, Finder information ... not allowed").
set -e
cd "$(dirname "$0")/.."
BUILD_DIR="${PADCHOP_BUILD_DIR:-$HOME/Library/Developer/padchop-build}"
CONFIG="${CONFIG:-Release}"

npm run build
AUV3=OFF
TARGETS="padchop_plugin_VST3 padchop_plugin_AU padchop_plugin_Standalone"
if [ "$1" = "--auv3" ]; then AUV3=ON; TARGETS="$TARGETS padchop_plugin_AUv3"; fi
cmake -S native -B "$BUILD_DIR" -G Xcode -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DPADCHOP_AUV3=$AUV3
for t in $TARGETS; do
  cmake --build "$BUILD_DIR" --config "$CONFIG" --target "$t"
done
echo "Built into $BUILD_DIR/plugin/padchop_plugin_artefacts/$CONFIG"
echo "Installed: ~/Library/Audio/Plug-Ins/VST3/padchop.vst3, ~/Library/Audio/Plug-Ins/Components/padchop.component"
