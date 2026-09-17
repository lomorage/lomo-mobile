fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Push a new beta build to TestFlight

### ios build_production

```sh
[bundle exec] fastlane ios build_production
```

Build Production IPA

----


## Android

### android build_release

```sh
[bundle exec] fastlane android build_release
```

Build the release AAB

### android deploy

```sh
[bundle exec] fastlane android deploy
```

Build and upload a new release to the Google Play Console (defaults to the internal track)

### android promote_to_production

```sh
[bundle exec] fastlane android promote_to_production
```

Promote the current internal release to production at 100% rollout

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
