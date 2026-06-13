const { withProjectBuildGradle, withAppBuildGradle } = require('@expo/config-plugins');

module.exports = function withVideoCacheGradle(config) {
    config = withProjectBuildGradle(config, (config) => {
        let buildGradle = config.modResults.contents;
        
        const mavenUrl = 'maven { url "$rootDir/../node_modules/react-native-video-cache/android/libs" }';
        
        if (!buildGradle.includes('react-native-video-cache/android/libs')) {
            buildGradle = buildGradle.replace(
                /allprojects\s*\{\s*repositories\s*\{/,
                `allprojects {\n  repositories {\n    ${mavenUrl}`
            );
        }
        
        config.modResults.contents = buildGradle;
        return config;
    });

    config = withAppBuildGradle(config, (config) => {
        let buildGradle = config.modResults.contents;
        const slf4jDependency = "implementation 'org.slf4j:slf4j-android:1.7.36'";

        if (!buildGradle.includes('org.slf4j:slf4j-android')) {
            buildGradle = buildGradle.replace(
                /dependencies\s*\{/,
                `dependencies {\n    ${slf4jDependency}`
            );
        }

        config.modResults.contents = buildGradle;
        return config;
    });

    return config;
};
