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
    echo "Usage: ./run-ios-device.sh [options]"
    echo ""
    echo "Options:"
    echo "  -c, --clean         Perform a clean build (removes ios/ folder, regenerates files, and runs pod install)"
    echo "  -d, --device        Specify a device name or UDID (e.g. \"iPhone 17\")"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./run-ios-device.sh"
    echo "  ./run-ios-device.sh --clean"
    echo "  ./run-ios-device.sh --device \"iPhone 17\""
    echo "  ./run-ios-device.sh -c -d \"iPhone 17\""
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        -c|--clean) CLEAN=true ;;
        -d|--device) TARGET_DEVICE="$2"; shift ;;
        -h|--help) show_help; exit 0 ;;
        *) echo "Unknown parameter: $1"; show_help; exit 1 ;;
    esac
    shift
done

echo "=============================================="
echo "🚀 Starting iOS Device Build and Run Process"
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

echo "📱 Launching Expo..."
RUN_CMD="npx expo run:ios --no-bundler"

if [ -n "$TARGET_DEVICE" ]; then
    RUN_CMD="$RUN_CMD --device \"$TARGET_DEVICE\""
else
    RUN_CMD="$RUN_CMD --device"
fi

echo ""
echo "Running: $RUN_CMD"
echo "=============================================="
eval $RUN_CMD

echo ""
echo "=============================================="
echo "🌐 Starting Development Server..."
echo "=============================================="
npx expo start

