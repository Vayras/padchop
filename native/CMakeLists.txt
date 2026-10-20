cmake_minimum_required(VERSION 3.22)
project(padchop VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")

option(PADCHOP_BUILD_PLUGIN "Build the JUCE plugin (VST3/AU/AUv3/Standalone)" ON)

# ---- DSP library (no framework dependencies) ----
add_library(padchop_dsp STATIC
    dsp/src/fft.cpp
    dsp/src/transients.cpp
    dsp/src/tempo.cpp
    dsp/src/key.cpp
    dsp/src/regions.cpp
    dsp/src/hints.cpp
    dsp/src/analyze.cpp
    dsp/src/chop.cpp
    dsp/src/stretch.cpp
    dsp/src/resample.cpp)
target_include_directories(padchop_dsp PUBLIC dsp/include)
set_target_properties(padchop_dsp PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(NOT MSVC)
    target_compile_options(padchop_dsp PRIVATE -Wall -Wextra -Wno-sign-compare)
endif()

# ---- Tests ----
enable_testing()
add_executable(padchop_tests tests/test_dsp.cpp)
target_link_libraries(padchop_tests PRIVATE padchop_dsp)
add_test(NAME dsp COMMAND padchop_tests)


# Command-line analysis, for checking the port against the TypeScript version.
add_executable(padchop_analyze tests/analyze_cli.cpp)
target_link_libraries(padchop_analyze PRIVATE padchop_dsp)

# ---- Plugin ----
if(PADCHOP_BUILD_PLUGIN)
    if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/third_party/JUCE/CMakeLists.txt)
        add_subdirectory(third_party/JUCE)
    else()
        include(FetchContent)
        FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.15 GIT_SHALLOW TRUE)
        FetchContent_MakeAvailable(JUCE)
    endif()
    add_subdirectory(plugin)
endif()
