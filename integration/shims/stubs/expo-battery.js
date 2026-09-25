module.exports = {
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
  getBatteryLevelAsync: async () => 1,
  getBatteryStateAsync: async () => 3,
  isLowPowerModeEnabledAsync: async () => false,
};
