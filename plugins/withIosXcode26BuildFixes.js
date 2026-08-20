const { withPodfile, withPodfileProperties } = require('@expo/config-plugins');

// Build React Native from source instead of using Expo/RN's prebuilt core
// XCFramework. The prebuilt debug artifact is missing some dev-only symbols
// (RCTPackagerConnection, Fabric debug helpers, ...) needed to link a physical
// -device Debug build, causing "Undefined symbols for architecture arm64".
function withBuildReactNativeFromSource(config) {
  return withPodfileProperties(config, (config) => {
    config.modResults['ios.buildReactNativeFromSource'] = 'true';
    return config;
  });
}

const MARKER = '# --- withIosXcode26BuildFixes ---';

const POST_INSTALL_BLOCK = `${MARKER}
    # Fix "Unable to resolve module dependency: 'argon2'" (and similar custom
    # Clang-module-map pods) when building React Native from source.
    #
    # Root cause: react_native_post_install only reverts Xcode 26's new
    # SWIFT_ENABLE_EXPLICIT_MODULES default to NO when using the *prebuilt* rncore
    # (see node_modules/react-native/scripts/react_native_pods.rb, "In XCode 26 we
    # need to revert..."). When building from source instead, that guard is skipped,
    # so Xcode 26's explicit-modules build fails to resolve third-party pods that ship
    # a hand-written module.modulemap for a plain C library (e.g. Argon2Swift's
    # \`module argon2 { header "...argon2.h" }\`, imported via \`import argon2\` in Swift).
    #
    # Fix: apply the same override unconditionally, not just for the prebuilt path.
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |cfg|
        cfg.build_settings['SWIFT_ENABLE_EXPLICIT_MODULES'] = 'NO'
      end
    end

    # Fix "cannot link directly with 'SwiftUICore'" linker error.
    #
    # Root cause: several pods (expo-modules-core, expo-dev-launcher, expo-dev-menu,
    # expo-video, expo-font, ...) \`import SwiftUI\` and are compiled from source against
    # the local (very new) iOS SDK. With a deployment target below iOS 18 (the SwiftUI /
    # SwiftUICore split), swiftc's autolinker emits a direct \`-framework SwiftUICore\`
    # linker option instead of going through the public \`SwiftUI\` umbrella. SwiftUICore
    # is not an allowed direct client for third-party apps, so the link fails.
    #
    # Fix: tell swiftc to not autolink SwiftUICore directly; it still gets linked
    # transitively and correctly via the \`SwiftUI\` framework that these pods import.
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |cfg|
        flags = cfg.build_settings['OTHER_SWIFT_FLAGS'] || '$(inherited)'
        next if flags.include?('-disable-autolink-framework')

        cfg.build_settings['OTHER_SWIFT_FLAGS'] =
          "#{flags} -Xfrontend -disable-autolink-framework -Xfrontend SwiftUICore"
      end
    end

    # Fix "call to consteval function 'fmt::basic_format_string<...>::basic_format_string
    # <FMT_COMPILE_STRING, 0>' is not a constant expression" when building React Native
    # from source with a very new Clang.
    #
    # Root cause: this vendored fmt version's basic_format_string(const S& s) constructor
    # (Pods/fmt/include/fmt/base.h) initializes \`str_\` from \`s\` in the member-init list,
    # then separately calls \`checker(s)\` in the constructor body — a *second* evaluation
    # of the same compile-time string literal wrapper. Newer/stricter Clang requires a
    # consteval call's arguments to come from a single consistent evaluation, so this
    # double evaluation of \`s\` fails to be a constant expression. This is the same class
    # of bug fmt fixed upstream for its sibling \`fstring\` type (fmtlib/fmt#4177), just not
    # yet ported to this older \`basic_format_string\` type our vendored copy predates.
    #
    # Fix: reuse the already-constructed \`str_\` (a plain basic_string_view, no re-evaluation
    # needed) instead of re-referencing \`s\`.
    fmt_base_h = File.join(installer.config.installation_root, 'Pods', 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base_h)
      content = File.read(fmt_base_h)
      patched = content.sub(
        'detail::parse_format_string<true>(str_, checker(s));',
        'detail::parse_format_string<true>(str_, checker(str_));'
      )
      if patched != content
        File.chmod(0644, fmt_base_h)
        File.write(fmt_base_h, patched)
        puts '  ✅ Patched fmt/base.h basic_format_string double-evaluation bug'
      end
    end
`;

// Injects the post_install fixes above into the generated ios/Podfile, right
// after `post_install do |installer|`. Order relative to react_native_post_install
// doesn't matter: these only read/write installer.pods_project.targets, which is
// fully populated by the time post_install runs regardless of statement order.
function withPodfilePostInstallFixes(config) {
  return withPodfile(config, (config) => {
    const { contents } = config.modResults;
    if (contents.includes(MARKER)) {
      return config;
    }

    const anchor = 'post_install do |installer|\n';
    const index = contents.indexOf(anchor);
    if (index === -1) {
      throw new Error(
        "withIosXcode26BuildFixes: couldn't find 'post_install do |installer|' in the generated Podfile"
      );
    }

    const insertAt = index + anchor.length;
    config.modResults.contents =
      contents.slice(0, insertAt) + POST_INSTALL_BLOCK + contents.slice(insertAt);

    return config;
  });
}

// Xcode 26 / React Native 0.81+ build fixes for physical-device builds, ported
// from manual ios/Podfile edits so they survive `expo prebuild --clean`.
// See run-ios-device.sh history / PR description for the full diagnosis of each fix.
module.exports = function withIosXcode26BuildFixes(config) {
  config = withBuildReactNativeFromSource(config);
  config = withPodfilePostInstallFixes(config);
  return config;
};
