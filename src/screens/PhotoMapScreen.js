import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, Dimensions, ActivityIndicator, Modal, Platform, FlatList } from 'react-native';
import { Image } from 'expo-image';
import MapView, { Marker } from 'react-native-maps';
import Supercluster from 'supercluster';

import { useNavigation, useIsFocused } from '@react-navigation/native';
import { ChevronLeft, X } from 'lucide-react-native';
import AssetDBService from '../services/AssetDBService';
import AuthService from '../services/AuthService';

const { width, height } = Dimensions.get('window');
const ASPECT_RATIO = width / height;
const LATITUDE_DELTA = 90;
const LONGITUDE_DELTA = LATITUDE_DELTA * ASPECT_RATIO;

// Separate component so each marker manages its own tracksViewChanges lifecycle.
// tracksViewChanges=true while image is loading, then false after onLoad fires,
// so Android re-captures the marker bitmap exactly once after the image appears.
const PhotoMarker = React.memo(({ coordinate, thumbUrl, onPress, isMapMoving }) => {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);

  const stopTracking = useCallback(() => {
    // A brief delay to let the map capture the final rendered image
    setTimeout(() => {
      setTracksViewChanges(false);
    }, 500);
  }, []);

  useEffect(() => {
    setTracksViewChanges(true);

    // Fallback: stop tracking after 6 seconds anyway
    const fallbackTimer = setTimeout(() => {
      setTracksViewChanges(false);
    }, 6000);

    return () => {
      clearTimeout(fallbackTimer);
    };
  }, [thumbUrl]);

  return (
    <Marker
      coordinate={coordinate}
      tracksViewChanges={isMapMoving || tracksViewChanges}
      onPress={onPress}
    >
      <Image
        source={{ uri: thumbUrl || '' }}
        style={{
          width: 52,
          height: 52,
          borderRadius: 10,
          borderWidth: 2,
          borderColor: '#fff',
          backgroundColor: '#ddd',
        }}
        contentFit="cover"
        onLoad={stopTracking}
      />
    </Marker>
  );
});

const ClusterMarker = React.memo(({ coordinate, pointCount, onPress, isMapMoving }) => {
  const [tracksViewChanges, setTracksViewChanges] = useState(true);

  useEffect(() => {
    setTracksViewChanges(true);
    const timer = setTimeout(() => {
      setTracksViewChanges(false);
    }, 500);
    return () => clearTimeout(timer);
  }, [pointCount]);

  return (
    <Marker
      coordinate={coordinate}
      tracksViewChanges={isMapMoving || tracksViewChanges}
      onPress={onPress}
    >
      <View style={styles.clusterWrap}>
        <Text style={styles.clusterText}>{pointCount}</Text>
      </View>
    </Marker>
  );
});

const MAX_ZOOM = 16;

export default function PhotoMapScreen() {
  const mapRef = useRef(null);
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const [points, setPoints] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [region, setRegion] = useState({
    latitude: 20,
    longitude: 0,
    latitudeDelta: LATITUDE_DELTA,
    longitudeDelta: LONGITUDE_DELTA,
  });
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [hdLoaded, setHdLoaded] = useState(false);
  const [selectedClusterAssets, setSelectedClusterAssets] = useState(null);
  const [isMapMoving, setIsMapMoving] = useState(false);

  const dataLoaded = useRef(false);

  const getThumbnailUrl = useCallback((hash) => {
    if (!hash) return null;
    return `${AuthService.getServerUrl()}/preview/${hash}?width=75&height=-1&token=${AuthService.getToken()}`;
  }, []);

  const getFullImageUrl = useCallback((hash) => {
    if (!hash) return null;
    return `${AuthService.getServerUrl()}/preview/${hash}?width=1200&height=-1&token=${AuthService.getToken()}`;
  }, []);

  const getLocalUri = useCallback((id, mediaType) => {
    if (!id) return null;
    if (Platform.OS === 'ios') {
      return `ph://${id}`;
    } else {
      const type = mediaType === 'video' ? 'video' : 'images';
      return `content://media/external/${type}/media/${id}`;
    }
  }, []);

  const supercluster = useMemo(() => {
    return new Supercluster({
      radius: 40,
      maxZoom: MAX_ZOOM,
    });
  }, []);

  const [coordsToFit, setCoordsToFit] = useState([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapMeasured, setMapMeasured] = useState(false);
  const hasFitted = useRef(false);

  const fitMapToCoords = useCallback((coordinates) => {
    if (!coordinates || coordinates.length === 0 || !mapRef.current) {
      console.log(`[PhotoMapScreen] fitMapToCoords aborted: coordinates length = ${coordinates ? coordinates.length : 'null'}, mapRef = ${!!mapRef.current}`);
      return;
    }

    console.log(`[PhotoMapScreen] fitMapToCoords: fitting ${coordinates.length} coordinates.`);

    if (coordinates.length === 1) {
      const singleCoord = coordinates[0];
      console.log(`[PhotoMapScreen] fitMapToCoords: 1 coordinate found. Animating to:`, singleCoord);
      mapRef.current.animateToRegion({
        latitude: singleCoord.latitude,
        longitude: singleCoord.longitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05 * ASPECT_RATIO,
      }, 500);
      return;
    }

    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;

    for (const c of coordinates) {
      if (c.latitude < minLat) minLat = c.latitude;
      if (c.latitude > maxLat) maxLat = c.latitude;
      if (c.longitude < minLon) minLon = c.longitude;
      if (c.longitude > maxLon) maxLon = c.longitude;
    }

    const latDelta = maxLat - minLat;
    const lonDelta = maxLon - minLon;

    console.log(`[PhotoMapScreen] fitMapToCoords: calculated min/max lat: [${minLat}, ${maxLat}], lon: [${minLon}, ${maxLon}], delta lat: ${latDelta}, lon: ${lonDelta}`);

    if (latDelta < 0.01 && lonDelta < 0.01) {
      const targetLat = (minLat + maxLat) / 2;
      const targetLon = (minLon + maxLon) / 2;
      console.log(`[PhotoMapScreen] fitMapToCoords: coordinates are extremely close. Animating to centered region: [${targetLat}, ${targetLon}]`);
      mapRef.current.animateToRegion({
        latitude: targetLat,
        longitude: targetLon,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02 * ASPECT_RATIO,
      }, 500);
    } else {
      console.log(`[PhotoMapScreen] fitMapToCoords: calling fitToCoordinates.`);
      mapRef.current.fitToCoordinates(coordinates, {
        edgePadding: { top: 100, right: 50, bottom: 50, left: 50 },
        animated: true,
      });
    }
  }, []);

  useEffect(() => {
    console.log(`[PhotoMapScreen] camera fit useEffect hook: mapReady=${mapReady}, mapMeasured=${mapMeasured}, coordsCount=${coordsToFit.length}, hasFitted=${hasFitted.current}`);
    if (mapReady && mapMeasured && coordsToFit.length > 0 && mapRef.current && !hasFitted.current) {
      hasFitted.current = true;
      console.log(`[PhotoMapScreen] camera fit conditions met! Scheduling fitMapToCoords in 500ms...`);
      setTimeout(() => {
        fitMapToCoords(coordsToFit);
      }, 500);
    }
  }, [mapReady, mapMeasured, coordsToFit, fitMapToCoords]);

  useEffect(() => {
    console.log(`[PhotoMapScreen] focus useEffect hook: isFocused=${isFocused}`);
    if (isFocused) {
      loadAssets();
    }
  }, [isFocused]);

  useEffect(() => {
    const { DeviceEventEmitter } = require('react-native');
    console.log(`[PhotoMapScreen] remoteAssetsUpdated listener useEffect hook: isFocused=${isFocused}`);
    const sub = DeviceEventEmitter.addListener('remoteAssetsUpdated', () => {
      console.log(`[PhotoMapScreen] remoteAssetsUpdated event received, isFocused=${isFocused}`);
      if (isFocused) {
        loadAssets();
      }
    });
    return () => {
      console.log(`[PhotoMapScreen] remoteAssetsUpdated listener cleanup`);
      sub.remove();
    };
  }, [isFocused]);

  const loadAssets = async () => {
    try {
      await AssetDBService.init();
      const assets = await AssetDBService.getAssetsWithGeo();
      console.log(`[PhotoMapScreen] Loaded ${assets.length} assets with geo.`);

      // Prefetch thumbnails so they are in the native image cache before markers render.
      // This dramatically improves the chance that the Android bitmap snapshot captures the image.
      const serverUrl = AuthService.getServerUrl();
      const token = AuthService.getToken();
      if (serverUrl && token) {
        const prefetchUrls = assets
          .filter(a => a.hash && a.isLocal === 0)
          .slice(0, 200)
          .map(a => getThumbnailUrl(a.hash));

        // Fire-and-forget: don't block rendering
        Promise.all(prefetchUrls.map(url => Image.prefetch(url).catch(() => {}))).catch(() => {});
      }
      
      const validAssets = assets.filter(asset => {
        const lat = asset.latitude;
        const lon = asset.longitude;
        return (
          typeof lat === 'number' &&
          typeof lon === 'number' &&
          !isNaN(lat) &&
          !isNaN(lon) &&
          lat >= -90 &&
          lat <= 90 &&
          lon >= -180 &&
          lon <= 180 &&
          (lat !== 0 || lon !== 0)
        );
      });

      const geojsonPoints = validAssets.map(asset => ({
        type: 'Feature',
        properties: {
          cluster: false,
          assetId: asset.id,
          hash: asset.hash,
          isLocal: asset.isLocal === 1,
          mediaType: asset.mediaType,
        },
        geometry: {
          type: 'Point',
          coordinates: [asset.longitude, asset.latitude],
        },
      }));
      
      supercluster.load(geojsonPoints);
      dataLoaded.current = true;
      setPoints(geojsonPoints);
      updateClusters(region);

      // Fit map to show all photos
      console.log(`[PhotoMapScreen] loadAssets: validAssets count=${validAssets.length}`);
      if (validAssets.length > 0) {
        const coordinates = validAssets.map(a => ({
          latitude: a.latitude,
          longitude: a.longitude,
        }));
        console.log(`[PhotoMapScreen] loadAssets: setting coordsToFit with ${coordinates.length} coordinates.`);
        setCoordsToFit(coordinates);
      } else {
        console.log(`[PhotoMapScreen] loadAssets: no valid assets with geo coordinates found.`);
      }
    } catch (e) {
      console.error('[PhotoMapScreen] Failed to load assets:', e);
    } finally {
      setLoading(false);
    }
  };

  const updateClusters = (currentRegion) => {
    if (!dataLoaded.current) return;
    if (
      !currentRegion ||
      isNaN(currentRegion.latitude) ||
      isNaN(currentRegion.longitude) ||
      isNaN(currentRegion.latitudeDelta) ||
      isNaN(currentRegion.longitudeDelta) ||
      currentRegion.longitudeDelta <= 0 ||
      currentRegion.latitudeDelta <= 0
    ) {
      return;
    }

    const bbox = [
      currentRegion.longitude - currentRegion.longitudeDelta / 2,
      currentRegion.latitude - currentRegion.latitudeDelta / 2,
      currentRegion.longitude + currentRegion.longitudeDelta / 2,
      currentRegion.latitude + currentRegion.latitudeDelta / 2,
    ];
    let zoom = Math.round(Math.log(360 / currentRegion.longitudeDelta) / Math.LN2);
    if (isNaN(zoom) || !isFinite(zoom)) {
      zoom = 0;
    }
    const clampedZoom = Math.max(0, Math.min(zoom, MAX_ZOOM));
    const newClusters = supercluster.getClusters(bbox, clampedZoom);
    setClusters(newClusters);

    // Prefetch the visible single photos in viewport!
    const visibleSingleHashes = newClusters
      .filter(c => !c.properties.cluster && !c.properties.isLocal && c.properties.hash)
      .map(c => c.properties.hash);

    if (visibleSingleHashes.length > 0) {
      const serverUrl = AuthService.getServerUrl();
      const token = AuthService.getToken();
      if (serverUrl && token) {
        const prefetchUrls = visibleSingleHashes.map(hash => getThumbnailUrl(hash));
        Promise.all(prefetchUrls.map(url => Image.prefetch(url).catch(() => {}))).catch(() => {});
      }
    }
  };

  const onRegionChange = useCallback(() => {
    if (!isMapMoving) {
      setIsMapMoving(true);
    }
  }, [isMapMoving]);

  const onRegionChangeComplete = (newRegion) => {
    setRegion(newRegion);
    setIsMapMoving(false);
    updateClusters(newRegion);
  };



  const openPhoto = useCallback((asset) => {
    setHdLoaded(false);
    setSelectedAsset(asset);
    // Prefetch HD image in background, then swap
    if (asset.fullUrl) {
      Image.prefetch(asset.fullUrl)
        .then(() => setHdLoaded(true))
        .catch(() => {}); // keep showing thumbnail if HD fails
    }
  }, []);

  const renderCluster = (cluster) => {
    const { cluster: isCluster, point_count } = cluster.properties;
    const [longitude, latitude] = cluster.geometry.coordinates;

    if (isCluster) {
      return (
        <ClusterMarker
          key={`cluster-${cluster.id}`}
          coordinate={{ latitude, longitude }}
          pointCount={point_count}
          isMapMoving={isMapMoving}
          onPress={(e) => {
            e.stopPropagation();
            try {
              const expansionZoom = supercluster.getClusterExpansionZoom(cluster.id);
              const currentZoom = Math.round(Math.log(360 / region.longitudeDelta) / Math.LN2);

              if (expansionZoom > MAX_ZOOM || currentZoom >= 15) {
                const leaves = supercluster.getLeaves(cluster.id, Infinity);
                const clusterAssets = leaves.map(leaf => {
                  const { assetId, hash, isLocal, mediaType } = leaf.properties;
                  const thumbUrl = isLocal ? getLocalUri(assetId, mediaType) : (hash ? getThumbnailUrl(hash) : null);
                  const fullUrl = isLocal ? getLocalUri(assetId, mediaType) : (hash ? getFullImageUrl(hash) : null);
                  return { id: assetId, hash, isLocal, mediaType, thumbUrl, fullUrl };
                });
                setSelectedClusterAssets(clusterAssets);
              } else {
                const newLatDelta = 360 / Math.pow(2, expansionZoom);
                const newLonDelta = newLatDelta * ASPECT_RATIO;
                mapRef.current?.animateToRegion({
                  latitude,
                  longitude,
                  latitudeDelta: newLatDelta,
                  longitudeDelta: newLonDelta,
                }, 500);
              }
            } catch (err) {
              console.error('[PhotoMapScreen] Failed to expand cluster:', err);
              // Fallback: load leaves directly if error occurs (e.g. cluster ID missing or invalid expansionZoom)
              try {
                const leaves = supercluster.getLeaves(cluster.id, Infinity);
                const clusterAssets = leaves.map(leaf => {
                  const { assetId, hash, isLocal, mediaType } = leaf.properties;
                  const thumbUrl = isLocal ? getLocalUri(assetId, mediaType) : (hash ? getThumbnailUrl(hash) : null);
                  const fullUrl = isLocal ? getLocalUri(assetId, mediaType) : (hash ? getFullImageUrl(hash) : null);
                  return { id: assetId, hash, isLocal, mediaType, thumbUrl, fullUrl };
                });
                setSelectedClusterAssets(clusterAssets);
              } catch (leafErr) {
                console.error('[PhotoMapScreen] Failed to get leaves on error fallback:', leafErr);
              }
            }
          }}
        />
      );
    }

    // Single point
    const { assetId, hash, isLocal, mediaType } = cluster.properties;
    const thumbUrl = isLocal ? getLocalUri(assetId, mediaType) : (hash ? getThumbnailUrl(hash) : null);
    const fullUrl = isLocal ? getLocalUri(assetId, mediaType) : (hash ? getFullImageUrl(hash) : null);
    
    return (
      <PhotoMarker
        key={`asset-${assetId}`}
        coordinate={{ latitude, longitude }}
        thumbUrl={thumbUrl}
        isMapMoving={isMapMoving}
        onPress={(e) => {
          e.stopPropagation();
          openPhoto({ thumbUrl, fullUrl, hash, isLocal });
        }}
      />
    );
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={region}
        onRegionChange={onRegionChange}
        onRegionChangeComplete={onRegionChangeComplete}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          console.log(`[PhotoMapScreen] MapView onLayout: width=${width}, height=${height}`);
          if (width > 0 && height > 0) {
            setMapMeasured(true);
          }
        }}
        onMapReady={() => {
          console.log(`[PhotoMapScreen] MapView onMapReady fired.`);
          setMapReady(true);
        }}
        clusteringEnabled={false} 
        pitchEnabled={true}
        rotateEnabled={false}
      >
        {clusters.map(renderCluster)}
      </MapView>

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <ChevronLeft color="#fff" size={24} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Photo Map</Text>
      </View>

      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading photos...</Text>
        </View>
      )}

      {!loading && points.length === 0 && (
        <View style={styles.emptyStateContainer}>
          <Text style={styles.emptyStateText}>No Photos with Location Data</Text>
          <Text style={styles.emptyStateSubtext}>Photos containing GPS info will appear here as they sync.</Text>
        </View>
      )}

      {/* Cluster Gallery Grid Modal */}
      <Modal
        visible={!!selectedClusterAssets}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setSelectedClusterAssets(null)}
      >
        <View style={styles.clusterModalContainer}>
          <View style={styles.clusterModalContent}>
            <View style={styles.clusterModalHeader}>
              <Text style={styles.clusterModalTitle}>
                {selectedClusterAssets ? `${selectedClusterAssets.length} Photos` : ''}
              </Text>
              <TouchableOpacity
                style={styles.clusterModalCloseButton}
                onPress={() => setSelectedClusterAssets(null)}
              >
                <X color="#fff" size={24} />
              </TouchableOpacity>
            </View>

            {selectedClusterAssets && (
              <FlatList
                data={selectedClusterAssets}
                keyExtractor={(item) => item.id}
                numColumns={3}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.gridItem}
                    onPress={() => openPhoto(item)}
                  >
                    <Image
                      source={{ uri: item.thumbUrl || '' }}
                      style={styles.gridImage}
                      contentFit="cover"
                    />
                  </TouchableOpacity>
                )}
                contentContainerStyle={styles.gridContentContainer}
              />
            )}
          </View>
        </View>
      </Modal>

      {/* Fullscreen Photo Viewer with progressive loading */}
      <Modal
        visible={!!selectedAsset}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setSelectedAsset(null)}
      >
        <View style={styles.modalContainer}>
          <TouchableOpacity 
            style={styles.closeButton} 
            onPress={() => setSelectedAsset(null)}
          >
            <X color="#fff" size={28} />
          </TouchableOpacity>

          {selectedAsset && (
            <View style={styles.progressiveImageContainer}>
              <Image 
                source={{ uri: hdLoaded ? selectedAsset.fullUrl : selectedAsset.thumbUrl }} 
                style={styles.fullScreenImage} 
                contentFit="contain"
                blurRadius={hdLoaded ? 0 : 15}
                transition={300}
              />

              {/* Loading pill while HD is loading */}
              {!hdLoaded && selectedAsset.fullUrl && (
                <View style={styles.hdLoadingIndicator}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.hdLoadingText}>Loading HD...</Text>
                </View>
              )}
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  map: {
    width: '100%',
    height: '100%',
  },
  header: {
    position: 'absolute',
    top: 50,
    left: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingRight: 15,
    borderRadius: 20,
  },
  backButton: {
    padding: 10,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginLeft: 5,
  },
  clusterWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#007AFF',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  clusterText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  photoMarkerWrap: {
    width: 52,
    height: 52,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: '#ddd',
  },
  photoMarkerImage: {
    width: 48,
    height: 48,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  loadingText: {
    color: '#fff',
    marginTop: 10,
    fontSize: 14,
  },
  emptyStateContainer: {
    position: 'absolute',
    top: '40%',
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.7)',
    padding: 20,
    borderRadius: 15,
    alignItems: 'center',
  },
  emptyStateText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 5,
  },
  emptyStateSubtext: {
    color: '#ccc',
    fontSize: 14,
    textAlign: 'center',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    padding: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 25,
  },
  progressiveImageContainer: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullScreenImage: {
    position: 'absolute',
    width: '100%',
    height: '100%',
  },
  hdImageOverlay: {
    zIndex: 1,
  },
  hdLoadingIndicator: {
    position: 'absolute',
    bottom: 60,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 2,
  },
  hdLoadingText: {
    color: '#fff',
    fontSize: 12,
    marginLeft: 8,
  },
  clusterModalContainer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  clusterModalContent: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: '60%',
    paddingTop: 15,
  },
  clusterModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2c2c2e',
  },
  clusterModalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  clusterModalCloseButton: {
    padding: 5,
  },
  gridContentContainer: {
    padding: 10,
  },
  gridItem: {
    flex: 1/3,
    aspectRatio: 1,
    padding: 2,
  },
  gridImage: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: '#333',
  },
});
