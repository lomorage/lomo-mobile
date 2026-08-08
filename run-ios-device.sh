#!/bin/bash
# Exit immediately if any command fails
set -e

# Set UTF-8 encoding for CocoaPods
export LANG=en_US.UTF-8
export LANGUAGE=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# Disable Expo telemetry to prevent file permission errors in non-interactive environments
export EXPO_NO_TELEMETRY=1

CLEAN=false
RESET_COREDEVICE=false
LIST_DEVICES=false
TARGET_DEVICE=""

# Help message
show_help() {
    echo "Usage: ./run-ios-device.sh [options]"
    echo ""
    echo "Options:"
    echo "  -c, --clean         Perform a clean build (removes ios/ folder, regenerates files, and runs pod install)"
    echo "  -d, --device        Specify a device name or UDID (e.g. \"iPhone 17\" or \"00008020-...\")"
    echo "  -l, --list          List available connected physical Apple devices and simulators"
    echo "  -r, --reset         Reset CoreDevice/devicectl background services if physical device is busy"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./run-ios-device.sh"
    echo "  ./run-ios-device.sh --clean"
    echo "  ./run-ios-device.sh --device \"iPhone 17\""
    echo "  ./run-ios-device.sh -c -d \"00008020-000B59800246002E\""
    echo "  ./run-ios-device.sh --reset"
}

# Function to list available devices
list_available_devices() {
    echo "=============================================="
    echo "📱 Physical Apple Devices & Simulators"
    echo "=============================================="
    xcrun xctrace list devices 2>&1
}

# Helper: keep only iPhone/iPad lines, drop the host Mac and non-iOS devices.
_filter_ios_devices() {
    local computer_name="$1"
    grep -iE '^[[:space:]]*(iPhone|iPad)' \
    | grep -v -iE '(Mac|Apple TV|Apple Watch|iPod)' \
    | { [ -n "$computer_name" ] && grep -v "$computer_name" || cat; } \
    || true
}

# Extract the last parenthesised token (the UDID) from an xctrace device line.
# e.g. "iPhone (105) (15.8.2) (7e7292b7...)" → "7e7292b7..."
_extract_udid() {
    sed 's/.*([^)]*)$//' | sed 's/.*(\/*//' | rev | cut -d'(' -f1 | rev | tr -d ')'
}

# Build a list of all iPhone/iPad devices (online first, then offline).
# Outputs lines of the form: "<label>|<udid>|<status>"
_list_ios_devices() {
    local COMPUTER_NAME
    COMPUTER_NAME=$(scutil --get ComputerName 2>/dev/null || echo "")
    local RAW
    RAW=$(xcrun xctrace list devices 2>&1)

    # Online devices
    echo "$RAW" \
        | awk '/== Devices ==/{flag=1; next} /== Devices Offline ==|== Simulators ==/{flag=0} flag && NF' \
        | _filter_ios_devices "$COMPUTER_NAME" \
        | while IFS= read -r line; do
            local udid label
            udid=$(echo "$line" | sed 's/.*(\.*//' | grep -oE '[0-9A-Fa-f-]{36,40}' | tail -n 1)
            label=$(echo "$line" | sed 's/ ([^)]*)$//')
            [ -n "$udid" ] && echo "${label}|${udid}|online"
          done

    # Offline devices
    echo "$RAW" \
        | awk '/== Devices Offline ==/{flag=1; next} /== Simulators ==/{flag=0} flag && NF' \
        | _filter_ios_devices "$COMPUTER_NAME" \
        | while IFS= read -r line; do
            local udid label
            udid=$(echo "$line" | grep -oE '[0-9A-Fa-f-]{36,40}' | tail -n 1)
            label=$(echo "$line" | sed 's/ ([^)]*)$//')
            [ -n "$udid" ] && echo "${label}|${udid}|offline"
          done
}

# Auto-detect: return UDID of the first online iPhone/iPad (or offline as fallback).
auto_detect_device() {
    local COMPUTER_NAME
    COMPUTER_NAME=$(scutil --get ComputerName 2>/dev/null || echo "")
    local RAW
    RAW=$(xcrun xctrace list devices 2>&1)

    # 1. Prefer ONLINE physical devices first.
    local ONLINE_UDID
    ONLINE_UDID=$(echo "$RAW" \
        | awk '/== Devices ==/{flag=1; next} /== Devices Offline ==|== Simulators ==/{flag=0} flag && NF' \
        | _filter_ios_devices "$COMPUTER_NAME" \
        | head -n 1 \
        | grep -oE '[0-9A-Fa-f-]{36,40}' | tail -n 1)
    [ -n "$ONLINE_UDID" ] && echo "$ONLINE_UDID" && return 0

    # 2. Fall back to OFFLINE physical devices.
    local OFFLINE_UDID
    OFFLINE_UDID=$(echo "$RAW" \
        | awk '/== Devices Offline ==/{flag=1; next} /== Simulators ==/{flag=0} flag && NF' \
        | _filter_ios_devices "$COMPUTER_NAME" \
        | head -n 1 \
        | grep -oE '[0-9A-Fa-f-]{36,40}' | tail -n 1)
    [ -n "$OFFLINE_UDID" ] && echo "$OFFLINE_UDID" && return 0

    # 3. Fallback: devicectl.
    local DEVICECTL_UDID
    DEVICECTL_UDID=$(xcrun devicectl list devices 2>&1 \
        | grep -iE '(iPhone|iPad)' \
        | grep -oE '[0-9A-Fa-f-]{36,40}' | head -n 1)
    [ -n "$DEVICECTL_UDID" ] && echo "$DEVICECTL_UDID" && return 0

    # Last resort.
    echo "iPhone"
}

# Interactive device picker.
# Shows all iPhone/iPad devices, marks the auto-detected default, lets the user choose.
pick_device() {
    local default_udid="$1"

    # Collect devices into arrays.
    local labels=() udids=() statuses=()
    while IFS='|' read -r label udid status; do
        labels+=("$label")
        udids+=("$udid")
        statuses+=("$status")
    done < <(_list_ios_devices)

    local count=${#udids[@]}

    if [ "$count" -eq 0 ]; then
        echo "⚠️  No iPhone/iPad devices found. Falling back to default." >&2
        echo "$default_udid"
        return
    fi

    if [ "$count" -eq 1 ]; then
        # Only one device — no need to prompt, just confirm.
        local status_icon="📴"
        [ "${statuses[0]}" = "online" ] && status_icon="✅"
        echo "" >&2
        echo "📱 One device found — using it automatically:" >&2
        echo "   ${status_icon} ${labels[0]} (${udids[0]})" >&2
        echo "" >&2
        echo "${udids[0]}"
        return
    fi

    # Find the index of the default device.
    local default_idx=0
    for i in "${!udids[@]}"; do
        if [ "${udids[$i]}" = "$default_udid" ]; then
            default_idx=$i
            break
        fi
    done

    # Print menu to stderr so it doesn't pollute the returned value.
    echo "" >&2
    echo "📱 Available iOS devices:" >&2
    for i in "${!udids[@]}"; do
        local status_icon="📴"
        [ "${statuses[$i]}" = "online" ] && status_icon="✅"
        local default_marker=""
        [ "$i" -eq "$default_idx" ] && default_marker=" [default]"
        echo "  $((i+1))) ${status_icon} ${labels[$i]} (${udids[$i]})${default_marker}" >&2
    done
    echo "" >&2
    printf "Select device [1-%d, default=%d]: " "$count" "$((default_idx+1))" >&2

    local choice
    read -r choice </dev/tty

    # Empty input → use default.
    if [ -z "$choice" ]; then
        echo "${udids[$default_idx]}"
        return
    fi

    # Validate numeric input.
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "$count" ]; then
        echo "${udids[$((choice-1))]}"
    else
        echo "⚠️  Invalid choice '$choice', using default." >&2
        echo "${udids[$default_idx]}"
    fi
}

# Function to reset stuck CoreDevice daemon
reset_core_device() {
    echo "🔄 Resetting CoreDevice / devicectl services..."
    killall devicectl 2>/dev/null || true
    killall com.apple.CoreDevice.CoreDeviceService 2>/dev/null || true
    echo "✓ CoreDevice services reset complete."
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        -c|--clean) CLEAN=true ;;
        -d|--device) TARGET_DEVICE="$2"; shift ;;
        -l|--list) LIST_DEVICES=true ;;
        -r|--reset) RESET_COREDEVICE=true ;;
        -h|--help) show_help; exit 0 ;;
        *) echo "Unknown parameter: $1"; show_help; exit 1 ;;
    esac
    shift
done

if [ "$LIST_DEVICES" = true ]; then
    list_available_devices
    exit 0
fi

if [ "$RESET_COREDEVICE" = true ]; then
    reset_core_device
fi

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

# Auto-detect target device if none specified, then offer interactive picker.
if [ -z "$TARGET_DEVICE" ]; then
    echo "🔍 Detecting connected iOS devices..."
    DEFAULT_DEVICE=$(auto_detect_device)
    TARGET_DEVICE=$(pick_device "$DEFAULT_DEVICE")
fi

echo "📱 Launching Expo..."
RUN_CMD="npx expo run:ios --no-bundler"

if [ -n "$TARGET_DEVICE" ]; then
    echo "📍 Target device identified: $TARGET_DEVICE"
    RUN_CMD="$RUN_CMD --device \"$TARGET_DEVICE\""
else
    echo "⚠️ No specific device detected. Running default 'npx expo run:ios'..."
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


