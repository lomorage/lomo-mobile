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
CONFIGURATION="Release"
FORCE_IOS_DEPLOY=false
USE_TUNNEL=false

# Help message
show_help() {
    echo "Usage: ./run-ios-device.sh [options]"
    echo ""
    echo "Options:"
    echo "  -c, --clean         Perform a clean build (removes ios/ folder, regenerates files, and runs pod install)"
    echo "  -d, --device        Specify a device name or UDID (e.g. \"iPhone 17\" or \"00008020-...\")"
    echo "  --debug             Install a Debug build (connects to Metro) instead of the default Release build"
    echo "  -l, --list          List available connected physical Apple devices and simulators"
    echo "  -r, --reset         Reset CoreDevice/devicectl background services if physical device is busy"
    echo "  --force-ios-deploy  Force using ios-deploy for installation (bypasses Xcode CoreDevice tunnel)"
    echo "  --tunnel            Start Metro in tunnel mode (works across networks/subnets, needs ngrok)"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "By default this installs a Release build (matches what TestFlight/App Store ship)."
    echo "Pass --debug for a development build with Metro/Fast Refresh/the dev menu."
    echo ""
    echo "If Xcode CoreDevice shows the device as offline (tunnel error), the script will"
    echo "automatically fall back to ios-deploy (requires: brew install ios-deploy)."
    echo ""
    echo "In --debug mode the script prints this Mac's LAN IP so you can paste it into"
    echo "the dev-client's 'Change Bundle Location' screen if auto-discovery doesn't work."
    echo "If the device can't reach that IP (different subnet/VPN/isolated Wi-Fi), pass"
    echo "--tunnel to route through ngrok instead."
    echo ""
    echo "Examples:"
    echo "  ./run-ios-device.sh"
    echo "  ./run-ios-device.sh --debug"
    echo "  ./run-ios-device.sh --clean"
    echo "  ./run-ios-device.sh --device \"iPhone 17\""
    echo "  ./run-ios-device.sh -c -d \"00008020-000B59800246002E\""
    echo "  ./run-ios-device.sh --reset"
    echo "  ./run-ios-device.sh --debug --force-ios-deploy"
    echo "  ./run-ios-device.sh --debug --tunnel"
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
# NOTE: Apple device UDIDs come in multiple length formats (25-char old style
# like 00008020-000B59800246002E, or 36-char standard UUID). We extract the
# last parenthesised hex token instead of relying on a fixed-length regex.
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
            # Extract the last (hex-only) parenthesised token — handles all UDID lengths.
            udid=$(echo "$line" | grep -oE '\([0-9A-Fa-f-]+\)' | tail -1 | tr -d '()')
            label=$(echo "$line" | sed 's/ ([^)]*)$//')
            [ -n "$udid" ] && echo "${label}|${udid}|online"
          done

    # Offline devices
    echo "$RAW" \
        | awk '/== Devices Offline ==/{flag=1; next} /== Simulators ==/{flag=0} flag && NF' \
        | _filter_ios_devices "$COMPUTER_NAME" \
        | while IFS= read -r line; do
            local udid label
            udid=$(echo "$line" | grep -oE '\([0-9A-Fa-f-]+\)' | tail -1 | tr -d '()')
            label=$(echo "$line" | sed 's/ ([^)]*)$//')
            [ -n "$udid" ] && echo "${label}|${udid}|offline"
          done
}

# Auto-detect: return UDID of the first online iPhone/iPad (or offline as fallback).
# Handles Apple's variable-length UDID formats (25-char old style AND 36-char UUID).
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
        | grep -oE '\([0-9A-Fa-f-]+\)' | tail -1 | tr -d '()')
    [ -n "$ONLINE_UDID" ] && echo "$ONLINE_UDID" && return 0

    # 2. Fall back to OFFLINE physical devices.
    local OFFLINE_UDID
    OFFLINE_UDID=$(echo "$RAW" \
        | awk '/== Devices Offline ==/{flag=1; next} /== Simulators ==/{flag=0} flag && NF' \
        | _filter_ios_devices "$COMPUTER_NAME" \
        | head -n 1 \
        | grep -oE '\([0-9A-Fa-f-]+\)' | tail -1 | tr -d '()')
    [ -n "$OFFLINE_UDID" ] && echo "$OFFLINE_UDID" && return 0

    # 3. ios-deploy fallback: detects devices via usbmuxd (works even when
    #    CoreDevice tunnel is broken and xctrace returns nothing useful).
    if command -v ios-deploy &>/dev/null; then
        local IOS_DEPLOY_UDID
        IOS_DEPLOY_UDID=$(ios-deploy --detect --timeout 3 2>/dev/null \
            | grep -oE 'Found [0-9A-Fa-f-]+' | head -n 1 | awk '{print $2}')
        [ -n "$IOS_DEPLOY_UDID" ] && echo "$IOS_DEPLOY_UDID" && return 0
    fi

    # 4. devicectl fallback (may return simulators — last resort before giving up).
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

# Print this Mac's LAN IP (tries common interface names, falls back to the
# interface used for the default route).
_lan_ip() {
    local ip iface
    for iface in en0 en1 en2 en3; do
        ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
        [ -n "$ip" ] && echo "$ip" && return 0
    done
    iface=$(route get 1.1.1.1 2>/dev/null | awk '/interface:/{print $2}')
    [ -n "$iface" ] && ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    [ -n "$ip" ] && echo "$ip"
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
        --debug) CONFIGURATION="Debug" ;;
        -l|--list) LIST_DEVICES=true ;;
        -r|--reset) RESET_COREDEVICE=true ;;
        --force-ios-deploy) FORCE_IOS_DEPLOY=true ;;
        --tunnel) USE_TUNNEL=true ;;
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

# ---------------------------------------------------------------------------
# Check whether the target device is reachable via Xcode CoreDevice or whether
# we need the ios-deploy fallback (libimobiledevice / usbmuxd path).
# ---------------------------------------------------------------------------

# Decide which install strategy to use first, before device detection,
# because the two paths use different sources of truth for the UDID.
USE_IOS_DEPLOY=false

if [ "$FORCE_IOS_DEPLOY" = true ]; then
    USE_IOS_DEPLOY=true
    echo "⚡ --force-ios-deploy set: will use ios-deploy for installation."
fi

# For the normal (CoreDevice) path: auto-detect via xctrace and offer picker.
# For the ios-deploy path we skip xctrace entirely and detect via ios-deploy.
if [ "$USE_IOS_DEPLOY" = false ]; then
    if [ -z "$TARGET_DEVICE" ]; then
        echo "🔍 Detecting connected iOS devices..."
        DEFAULT_DEVICE=$(auto_detect_device)
        TARGET_DEVICE=$(pick_device "$DEFAULT_DEVICE")
    fi

    # Check if the device is offline in CoreDevice (tunnel broken).
    DEVICE_IS_OFFLINE=false
    if [ -n "$TARGET_DEVICE" ]; then
        OFFLINE_CHECK=$(xcrun xctrace list devices 2>&1 | awk '/== Devices Offline ==/{flag=1; next} /== Simulators ==/{flag=0} flag' | grep -i "$TARGET_DEVICE" || true)
        if [ -n "$OFFLINE_CHECK" ]; then
            DEVICE_IS_OFFLINE=true
        fi
    fi

    if [ "$DEVICE_IS_OFFLINE" = true ]; then
        echo "⚠️  Device appears offline in Xcode CoreDevice (tunnel broken)."
        if command -v ios-deploy &>/dev/null; then
            echo "✅ ios-deploy found — switching to libimobiledevice deployment path."
            USE_IOS_DEPLOY=true
        else
            echo "❌ ios-deploy not found. Install it with: brew install ios-deploy"
            echo "   Attempting Xcode CoreDevice path anyway (may fail)..."
        fi
    fi
fi

if [ "$USE_IOS_DEPLOY" = true ]; then
    # -----------------------------------------------------------------------
    # ios-deploy path: build with xcodebuild using -sdk iphoneos (no device
    # connection required during build), then install via ios-deploy which
    # uses usbmuxd and bypasses the broken CoreDevice tunnel entirely.
    # -----------------------------------------------------------------------

    # Get the real device UDID directly from ios-deploy --detect.
    # This is the only reliable source when CoreDevice is broken.
    echo "🔍 Detecting device via ios-deploy (usbmuxd)..."
    IOS_DEPLOY_UDID=$(ios-deploy --detect --timeout 5 2>/dev/null \
        | grep -oE 'Found [0-9A-Fa-f-]+' | head -n 1 | awk '{print $2}')
    if [ -z "$IOS_DEPLOY_UDID" ]; then
        echo "❌ No device found by ios-deploy. Make sure the device is plugged in and trusted."
        exit 1
    fi
    echo "📱 Device UDID (via ios-deploy): $IOS_DEPLOY_UDID"

    WORKSPACE=$(find ios -name "*.xcworkspace" -maxdepth 2 | head -n 1)
    if [ -z "$WORKSPACE" ]; then
        echo "❌ No .xcworkspace found in ios/. Run with --clean to regenerate."
        exit 1
    fi
    SCHEME=$(basename "$WORKSPACE" .xcworkspace)
    DERIVED_DATA_DIR="ios/DerivedData"

    echo ""
    echo "🔨 Building $SCHEME ($CONFIGURATION) with xcodebuild..."
    echo "   Workspace : $WORKSPACE"
    echo "   Scheme    : $SCHEME"
    echo "   Build dir : $DERIVED_DATA_DIR"
    echo "   SDK       : iphoneos (no device connection needed for build)"
    echo "=============================================="

    # Use -sdk iphoneos instead of -destination id=... so xcodebuild never
    # tries to open a CoreDevice tunnel to the device during the build phase.
    # NOTE: don't override CONFIGURATION_BUILD_DIR here — CocoaPods' generated
    # xcconfigs compute PODS_CONFIGURATION_BUILD_DIR (used for framework pods'
    # search paths, e.g. Argon2Swift) from the default BUILD_DIR, which is left
    # untouched by such an override. That mismatch makes the app target look
    # for framework pods' module maps in DerivedData while they get built
    # elsewhere, failing with "module map file ... not found".
    xcodebuild \
        -workspace "$WORKSPACE" \
        -scheme "$SCHEME" \
        -configuration "$CONFIGURATION" \
        -sdk iphoneos \
        -arch arm64 \
        -derivedDataPath "$DERIVED_DATA_DIR" \
        build 2>&1 | xcpretty 2>/dev/null || xcodebuild \
            -workspace "$WORKSPACE" \
            -scheme "$SCHEME" \
            -configuration "$CONFIGURATION" \
            -sdk iphoneos \
            -arch arm64 \
            -derivedDataPath "$DERIVED_DATA_DIR" \
            build

    APP_PATH=$(find "$DERIVED_DATA_DIR" -name "*.app" -not -path "*/Intermediates/*" 2>/dev/null | head -n 1)
    if [ -z "$APP_PATH" ]; then
        echo "❌ Built .app bundle not found. Check xcodebuild output above."
        exit 1
    fi
    echo ""
    echo "📦 Found app bundle: $APP_PATH"
    echo "📲 Installing via ios-deploy on device: $IOS_DEPLOY_UDID"
    echo "=============================================="

    IOS_DEPLOY_ARGS="--id $IOS_DEPLOY_UDID --bundle \"$APP_PATH\""
    if [ "$CONFIGURATION" = "Debug" ]; then
        # --noninteractive: don't attach lldb; Metro handles JS debugging
        IOS_DEPLOY_ARGS="$IOS_DEPLOY_ARGS --noninteractive --justlaunch"
    else
        IOS_DEPLOY_ARGS="$IOS_DEPLOY_ARGS --justlaunch"
    fi

    # ios-deploy launches the app over the debugger protocol, which requires
    # Xcode DeviceSupport files matching the device's iOS version. When those
    # are missing (common right after an iOS update, before Xcode has them),
    # install still succeeds but the auto-launch step exits non-zero. Don't
    # let `set -e` kill the whole script over that — the app is on the device
    # either way, it just needs a manual tap to open.
    set +e
    eval ios-deploy $IOS_DEPLOY_ARGS
    IOS_DEPLOY_EXIT=$?
    set -e

    if [ $IOS_DEPLOY_EXIT -ne 0 ]; then
        echo ""
        echo "⚠️  ios-deploy could not auto-launch the app (exit $IOS_DEPLOY_EXIT), likely because"
        echo "   Xcode is missing DeviceSupport files for this device's iOS version."
        echo "   The app IS installed — open it manually from the home screen."
    fi

    if [ "$CONFIGURATION" = "Debug" ]; then
        echo ""
        echo "=============================================="
        echo "🌐 Starting Development Server..."
        if [ "$USE_TUNNEL" = true ]; then
            echo "   Tunnel mode: the dev-client should auto-discover it, no IP needed."
            echo "=============================================="
            npx expo start --dev-client --tunnel
        else
            LAN_IP=$(_lan_ip)
            if [ -n "$LAN_IP" ]; then
                echo "   Shake your device → 'Change Bundle Location' → enter: $LAN_IP:8081"
                echo "   (Device must be on the same Wi-Fi. If that fails, rerun with --tunnel.)"
            else
                echo "   Shake your device → 'Change Bundle Location' → enter this Mac's IP"
            fi
            echo "=============================================="
            npx expo start --dev-client
        fi
    else
        echo ""
        echo "=============================================="
        echo "✅ Release build installed via ios-deploy. App should be launching."
        echo "=============================================="
    fi

else
    # -----------------------------------------------------------------------
    # Normal Xcode CoreDevice path via expo run:ios.
    # -----------------------------------------------------------------------
    echo "📱 Launching Expo ($CONFIGURATION build)..."
    RUN_CMD="npx expo run:ios --no-bundler --configuration \"$CONFIGURATION\""

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

    if [ "$CONFIGURATION" = "Debug" ]; then
        echo ""
        echo "=============================================="
        echo "🌐 Starting Development Server..."
        if [ "$USE_TUNNEL" = true ]; then
            echo "   Tunnel mode: the dev-client should auto-discover it, no IP needed."
            echo "=============================================="
            npx expo start --tunnel
        else
            LAN_IP=$(_lan_ip)
            if [ -n "$LAN_IP" ]; then
                echo "   If the app doesn't connect automatically, shake it → 'Change Bundle"
                echo "   Location' → enter: $LAN_IP:8081 (device must be on the same Wi-Fi)."
            fi
            echo "=============================================="
            npx expo start
        fi
    else
        echo ""
        echo "=============================================="
        echo "✅ Release build installed. It runs standalone (no Metro/dev server needed)."
        echo "=============================================="
    fi
fi
