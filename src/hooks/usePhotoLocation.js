import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import axios from 'axios';
import AuthService from '../services/AuthService';
import AssetDBService from '../services/AssetDBService';
import MediaService from '../services/MediaService';
import NetworkQueue from '../services/NetworkQueue';
import { hasPlaceName, validCoords } from '../screens/assetDetailScreenHelpers';

const GROUP = 'AssetDetailLocation';
const LOOKUP_DELAY_MS = 1000;

// Where the photo on screen was taken, for the line under it in the photo viewer.
//
// The app's database answers first (coordinates, and the place name once the background pass
// has looked it up). A photo that isn't there yet gets its coordinates from where they live:
// the server for a backed-up photo, the phone's library for one that is only on the phone.
// A place name still missing is looked up for this one photo, which needs location permission:
// the background pass needs it too, and the app otherwise only asks on the Map screen. So when
// it hasn't been granted, the viewer offers a tap to allow it (requestPlaceNames).
export function usePhotoLocation(asset) {
  const [location, setLocation] = useState(null);
  const [permission, setPermission] = useState(null); // { granted, canAskAgain }
  const assetKey = `${asset?.id || ''}|${asset?.hash || ''}`;
  const current = useRef(assetKey);
  current.current = assetKey;
  const lookedUp = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Location.getForegroundPermissionsAsync()
      .then(({ status, canAskAgain }) => {
        if (!cancelled) setPermission({ granted: status === 'granted', canAskAgain: canAskAgain !== false });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setLocation(null);
    if (!asset?.id && !asset?.hash) return undefined;
    const key = assetKey;
    const stillCurrent = () => current.current === key;

    (async () => {
      let found = await AssetDBService.getAssetLocation(asset.id, asset.hash);
      if (found?.none) return; // known to have no location: nothing to fetch
      if (!found && asset.hash && asset.status !== 'local') {
        // Only for a photo the user stays on: the NAS is slow, and swiping through must not
        // send it a request per photo.
        await new Promise(resolve => setTimeout(resolve, LOOKUP_DELAY_MS));
        if (!stillCurrent()) return;
        found = await fetchServerCoords(asset.hash);
      }
      if (!found && asset.id && asset.status !== 'remote') {
        found = await readPhoneCoords(asset.id);
      }
      if (stillCurrent() && found) setLocation(found);
    })().catch(e => console.warn('[usePhotoLocation] Could not read the location:', e?.message));

    return () => NetworkQueue.cancelGroup(GROUP);
  }, [assetKey]);

  // Look up the place name for the photo on screen when only its coordinates are known.
  useEffect(() => {
    if (!permission?.granted || !location || hasPlaceName(location)) return;
    const coords = validCoords(location.latitude, location.longitude);
    if (!coords) return;
    const key = assetKey;
    // Once per photo: an answer without a name changes `location` but must not ask again.
    if (lookedUp.current === key) return;
    // Only for a photo the user stays on: swiping through must not fire a burst of lookups,
    // which the OS rate-limits (and which would starve the background pass).
    const rowId = location.id;
    const timer = setTimeout(() => {
      lookedUp.current = key;
      Location.reverseGeocodeAsync(coords)
        .then(results => {
          const place = results && results[0];
          if (!place) return;
          // Keep it, so searching by place finds this photo without looking it up again.
          if (rowId) AssetDBService.saveAssetLocation(rowId, place, null);
          if (current.current !== key) return;
          setLocation(prev => (prev ? { ...prev, city: place.city, region: place.region, country: place.country } : prev));
        })
        .catch(e => console.warn('[usePhotoLocation] Place name lookup failed:', e?.message));
    }, LOOKUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [permission?.granted, location, assetKey]);

  const requestPlaceNames = useCallback(async () => {
    try {
      const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';
      setPermission({ granted, canAskAgain: canAskAgain !== false });
      if (granted) {
        // The rest of the library too, so searching by place works.
        require('../services/AIService').default.runBackgroundGeocoding()
          .catch(e => console.warn('[usePhotoLocation] place name pass failed:', e?.message));
      }
      return granted;
    } catch (e) {
      console.warn('[usePhotoLocation] Location permission request failed:', e?.message);
      return false;
    }
  }, []);

  const canAskForPlaceNames = !!location && !hasPlaceName(location)
    && !!validCoords(location.latitude, location.longitude)
    && permission != null && !permission.granted && permission.canAskAgain;

  return { location, canAskForPlaceNames, requestPlaceNames };
}

async function fetchServerCoords(hash) {
  const url = AuthService.getServerUrl();
  const token = AuthService.getToken();
  if (!url || !token) return null;
  try {
    const res = await axios.get(`${url}/asset/metadata/${hash}`, {
      headers: { Authorization: `token=${token}` },
      timeout: 5000,
      skipAutoProbe: true,
      priority: 2,
      groupId: GROUP,
    });
    return validCoords(res.data?.Latitude, res.data?.Longitude);
  } catch (e) {
    if (!axios.isCancel(e)) console.warn('[usePhotoLocation] Server metadata read failed:', e?.message);
    return null;
  }
}

async function readPhoneCoords(id) {
  const realId = id.startsWith('local-') ? id.slice('local-'.length) : id;
  const info = await MediaService.getAssetInfo(realId);
  return validCoords(info?.location?.latitude, info?.location?.longitude);
}
