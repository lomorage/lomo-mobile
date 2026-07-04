#!/bin/bash
# Exit immediately if any command fails
set -e

# Set UTF-8 encoding for CocoaPods
export LANG=en_US.UTF-8
export LANGUAGE=en_US.UTF-8
export LC_ALL=en_US.UTF-8

CLEAN=false
TARGET_DEVICE=""

# Help message
show_help() {
    echo "Usage: ./run-ios-simulator.sh [options]"
    echo ""
    echo "Options:"
    echo "  -c, --clean         Perform a clean build (removes ios/ folder, regenerates files, and runs pod install)"
    echo "  -d, --device        Specify a device/simulator name or UDID (e.g. \"iPhone 17\")"
    echo "  -s, --simulator     Specify a simulator name (alias for -d)"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./run-ios-simulator.sh"
    echo "  ./run-ios-simulator.sh --clean"
    echo "  ./run-ios-simulator.sh --device \"iPhone 17\""
    echo "  ./run-ios-simulator.sh -c -s \"iPhone 17\""
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        -c|--clean) CLEAN=true ;;
        -d|--device|-s|--simulator) TARGET_DEVICE="$2"; shift ;;
        -h|--help) show_help; exit 0 ;;
        *) echo "Unknown parameter: $1"; show_help; exit 1 ;;
    esac
    shift
done

apply_simulator_arch_fix() {
    # No longer needed, we use ARCHS=x86_64 explicitly below
    echo "✅ No simulator arch fix needed for generic build."
}

echo "=============================================="
echo "🚀 Starting iOS Simulator Build and Run Process"
echo "=============================================="

if [ "$CLEAN" = true ]; then
    echo "🧹 Clean option selected. Performing clean rebuild..."
    
    # 1. Clean the ios folder
    if [ -d "ios" ]; then
        echo "Removing existing 'ios' directory..."
        rm -rf ios
    fi
    
    # 2. Run expo prebuild with --clean to regenerate the folder
    echo "Regenerating native iOS files (Prebuild)..."
    npx expo prebuild --clean --platform ios
else
    # Check if ios folder exists, if not generate it
    if [ ! -d "ios" ]; then
        echo "No 'ios' folder found. Generating native iOS files (Prebuild)..."
        npx expo prebuild --platform ios
    fi
fi

ARCH_ARGS=""
ARCH_PREFIX=""
if [ "$(uname -m)" = "arm64" ]; then
    echo "💻 Apple Silicon Mac detected. Building x86_64 binary for Simulator..."
    ARCH_PREFIX="arch -x86_64 "
    ARCH_ARGS="ARCHS=x86_64 ONLY_ACTIVE_ARCH=NO"
fi

echo "🔨 Building iOS App..."
# Build generically for the simulator
eval "${ARCH_PREFIX}xcodebuild -workspace ios/lomomobile.xcworkspace -configuration Debug -scheme lomomobile -sdk iphonesimulator -destination \"generic/platform=iOS Simulator\" -derivedDataPath ios/build $ARCH_ARGS build"

APP_PATH="ios/build/Build/Products/Debug-iphonesimulator/lomomobile.app"

if [ ! -d "$APP_PATH" ]; then
    echo "❌ Build failed. App not found at $APP_PATH"
    exit 1
fi

echo "📱 Launching Expo..."
RUN_CMD="npx expo run:ios --binary \"$APP_PATH\""

if [ -n "$TARGET_DEVICE" ]; then
    RUN_CMD="$RUN_CMD --device \"$TARGET_DEVICE\""
fi

echo ""
echo "Running: $RUN_CMD"
echo "=============================================="
eval $RUN_CMD
