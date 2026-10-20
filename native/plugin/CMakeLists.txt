# padchop plugin: VST3, AU, AUv3 and a standalone app, with the web UI embedded.

# AUv3 ships as an app extension inside the standalone app and shares the AU's
# component id, so it shadows the AUv2 .component once registered. Hosts need it
# signed with an Apple Developer team, so it's opt-in until then.
option(PADCHOP_AUV3 "Also build the AUv3 extension (needs a signing team)" OFF)
set(PADCHOP_FORMATS VST3 AU Standalone)
if(PADCHOP_AUV3)
    list(APPEND PADCHOP_FORMATS AUv3)
endif()

juce_add_plugin(padchop_plugin
    PRODUCT_NAME "padchop"
    COMPANY_NAME "padchop"
    BUNDLE_ID "com.vayras.padchop"
    PLUGIN_MANUFACTURER_CODE Vyrs
    PLUGIN_CODE Pdch
    FORMATS ${PADCHOP_FORMATS}
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    NEEDS_WEB_BROWSER TRUE
    COPY_PLUGIN_AFTER_BUILD TRUE
    VST3_CATEGORIES Instrument Sampler
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    HARDENED_RUNTIME_ENABLED TRUE)

# The built web UI (npm run build -> ../dist), zipped into the binary.
set(PADCHOP_DIST ${CMAKE_CURRENT_SOURCE_DIR}/../../dist)
set(PADCHOP_UI_ZIP ${CMAKE_CURRENT_BINARY_DIR}/ui.zip)
file(GLOB_RECURSE PADCHOP_DIST_FILES CONFIGURE_DEPENDS ${PADCHOP_DIST}/*)
add_custom_command(
    OUTPUT ${PADCHOP_UI_ZIP}
    COMMAND ${CMAKE_COMMAND} -E rm -f ${PADCHOP_UI_ZIP}
    COMMAND ${CMAKE_COMMAND} -E chdir ${PADCHOP_DIST} zip -q -r -X ${PADCHOP_UI_ZIP} .
    DEPENDS ${PADCHOP_DIST_FILES}
    COMMENT "Zipping web UI")
juce_add_binary_data(padchop_ui HEADER_NAME PadchopUi.h NAMESPACE padchop_ui SOURCES ${PADCHOP_UI_ZIP})

target_sources(padchop_plugin PRIVATE
    src/PluginProcessor.cpp
    src/PluginEditor.cpp
    src/Engine.cpp
    src/RenderCache.cpp
    src/State.cpp)
if(APPLE)
    target_sources(padchop_plugin PRIVATE src/WebViewDrops.mm)
endif()

target_compile_definitions(padchop_plugin PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(padchop_plugin
    PRIVATE
        padchop_dsp
        padchop_ui
        juce::juce_audio_utils
        juce::juce_audio_formats
        juce::juce_dsp
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# Loads the built plugin like a DAW and checks that it plays (see tests/host_test.cpp).
juce_add_console_app(padchop_host_test PRODUCT_NAME "padchop_host_test")
target_sources(padchop_host_test PRIVATE ../tests/host_test.cpp)
target_compile_definitions(padchop_host_test PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=1
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0)
target_link_libraries(padchop_host_test PRIVATE juce::juce_audio_processors juce::juce_audio_utils
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
