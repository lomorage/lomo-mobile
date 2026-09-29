const { withFinalizedMod } = require('@expo/config-plugins');
const fs = require('fs/promises');
const path = require('path');

// The artwork includes its own rounded tile. Keep the complete tile inside
// Android's central 66dp safe circle on the 108dp adaptive icon canvas.
const INSET = '22%';

module.exports = function withAdaptiveIconInset(config) {
  if (!config.android?.adaptiveIcon?.foregroundImage) return config;

  // Expo regenerates launcher XML during prebuild, so apply the inset last.
  return withFinalizedMod(config, ['android', async (config) => {
    const resourceDir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res');
    const drawableDir = path.join(resourceDir, 'drawable');
    await fs.mkdir(drawableDir, { recursive: true });
    await fs.writeFile(path.join(drawableDir, 'ic_launcher_foreground_inset.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:drawable="@mipmap/ic_launcher_foreground"
    android:insetLeft="${INSET}"
    android:insetTop="${INSET}"
    android:insetRight="${INSET}"
    android:insetBottom="${INSET}" />
`);

    for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      const file = path.join(resourceDir, 'mipmap-anydpi-v26', name);
      const xml = await fs.readFile(file, 'utf8');
      const foreground = /(<foreground\b[^>]*android:drawable=")@(?:mipmap\/ic_launcher_foreground|drawable\/ic_launcher_foreground_inset)(")/;
      if (!foreground.test(xml)) {
        throw new Error(`Cannot apply adaptive icon inset: unexpected foreground in ${name}`);
      }
      await fs.writeFile(file, xml.replace(foreground, '$1@drawable/ic_launcher_foreground_inset$2'));
    }
    return config;
  }]);
};
