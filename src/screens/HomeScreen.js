import React, { useState, useEffect } from 'react';
import { StyleSheet, View, FlatList, Image, Dimensions, TouchableOpacity, Text, ActivityIndicator } from 'react-native';
import MediaService from '../services/MediaService';

const { width } = Dimensions.get('window');
const COLUMN_COUNT = 3;
const ITEM_SIZE = width / COLUMN_COUNT;

export default function HomeScreen({ navigation }) {
    const [assets, setAssets] = useState([]);
    const [loading, setLoading] = useState(true);
    const [hasNextPage, setHasNextPage] = useState(true);
    const [endCursor, setEndCursor] = useState(null);

    useEffect(() => {
        loadAssets();
    }, []);

    const loadAssets = async (after = null) => {
        const granted = await MediaService.requestPermissions();
        if (!granted) {
            setLoading(false);
            return;
        }

        const result = await MediaService.getAssets(60, after);
        if (after) {
            setAssets(prev => [...prev, ...result.assets]);
        } else {
            setAssets(result.assets);
        }
        setEndCursor(result.endCursor);
        setHasNextPage(result.hasNextPage);
        setLoading(false);
    };

    const handleLoadMore = () => {
        if (hasNextPage && !loading) {
            loadAssets(endCursor);
        }
    };

    const renderItem = ({ item }) => (
        <TouchableOpacity
            style={styles.itemContainer}
            onPress={() => navigation.navigate('AssetDetail', { asset: item })}
        >
            <Image source={{ uri: item.uri }} style={styles.image} />
        </TouchableOpacity>
    );

    if (loading && assets.length === 0) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color="#007AFF" />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <FlatList
                data={assets}
                renderItem={renderItem}
                keyExtractor={item => item.id}
                numColumns={COLUMN_COUNT}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.5}
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Text>No photos found or permission denied.</Text>
                    </View>
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20
    },
    itemContainer: {
        width: ITEM_SIZE,
        height: ITEM_SIZE,
        padding: 1,
    },
    image: {
        flex: 1,
        backgroundColor: '#eee',
    },
});
