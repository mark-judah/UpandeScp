// warehouse.js — Warehouse desk form scripts (migrated from Client Script fixtures).

// ---------------------------------------------------------------------------
// Warehouse Cost Center Query  (migrated from Client Script fixture, dt=Warehouse)
// ---------------------------------------------------------------------------
frappe.ui.form.on('Warehouse', {
    refresh(frm) {
        frm.set_query('custom_cost_center', () => ({
            filters: {
                company: frm.doc.company || '',
                disabled: 0,
                is_group: 0,
            }
        }));
    },
    company(frm) {
        if (frm.doc.custom_cost_center) {
            frm.set_value('custom_cost_center', null);
        }
    }
});

// ---------------------------------------------------------------------------
// Greenhouse Map  (migrated from Client Script fixture, dt=Warehouse)
// ---------------------------------------------------------------------------
frappe.ui.form.on('Warehouse', {
    refresh(frm) {
        console.debug('[Warehouse Script] Starting refresh function at', new Date().toISOString());
        // Use a slight delay to ensure the map is fully loaded
        setTimeout(() => {
            console.debug('[Warehouse Script] Inside setTimeout');
            const mapControl = frm.fields_dict['custom_location'];
            if (!mapControl || !mapControl.map) {
                console.warn('[Warehouse Script] Map control or map instance not found');
                return;
            }
            const map = mapControl.map;
            console.debug('[Warehouse Script] Map instance retrieved:', map);

            // Clear existing layers from the map to avoid duplicates
            console.debug('[Warehouse Script] Clearing existing layers');
            map.eachLayer(layer => {
                if (!layer._url) { // Keep base layers, remove other layers
                    map.removeLayer(layer);
                }
            });
            console.debug('[Warehouse Script] Layers cleared');

            // Define base layers
            console.debug('[Warehouse Script] Setting up base layers');
            const satellite = L.tileLayer(
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                    attribution: '© Esri',
                    maxZoom: 19
                }
            );

            const osm = L.tileLayer(
                'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors',
                    maxZoom: 19
                }
            );

            // Add base layers and a control to switch between them
            console.debug('[Warehouse Script] Adding base layers to map');
            satellite.addTo(map);
            const baseLayers = { "Satellite View": satellite, "Street Map": osm };
            L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
            console.debug('[Warehouse Script] Base layers and control added');

            // --- Custom GeoJSON Logic ---
            const rawGeoJSON = frm.doc.custom_raw_geojson;
            console.debug('[Warehouse Script] Raw custom_raw_geojson:', rawGeoJSON);
            if (rawGeoJSON) {
                try {
                    // Sanitize and parse the GeoJSON string
                    console.debug('[Warehouse Script] Sanitizing GeoJSON');
                    let cleanedGeoJSON = rawGeoJSON.trim();
                    if (cleanedGeoJSON.startsWith('"') && cleanedGeoJSON.endsWith('"')) {
                        cleanedGeoJSON = cleanedGeoJSON.slice(1, -1).replace(/\\"/g, '"');
                    }
                    console.debug('[Warehouse Script] Cleaned GeoJSON:', cleanedGeoJSON);

                    console.debug('[Warehouse Script] Parsing GeoJSON');
                    const geojson = JSON.parse(cleanedGeoJSON);
                    console.debug('[Warehouse Script] Parsed GeoJSON:', geojson);

                    if (geojson.type === 'FeatureCollection' && geojson.features && geojson.features.length > 0) {
                        console.debug('[Warehouse Script] Valid FeatureCollection detected, features:', geojson.features.length);
                        // Create a feature group to hold all polygons
                        const featureGroup = L.featureGroup();
                        console.debug('[Warehouse Script] Feature group created');

                        // Process each feature in the FeatureCollection
                        geojson.features.forEach((feature, index) => {
                            console.debug(`[Warehouse Script] Processing feature ${index}:`, feature);
                            if (feature.geometry && feature.geometry.type === 'Polygon') {
                                // Draw the polygon on the map
                                console.debug(`[Warehouse Script] Adding polygon for feature ${index}`);
                                const geoJsonLayer = L.geoJSON(feature, {
                                    style: {
                                        color: "#2b7fd4",
                                        weight: 3,
                                        opacity: 0.8,
                                        fillOpacity: 0.2
                                    },
                                    onEachFeature: (feature, layer) => {
                                        if (feature.properties && feature.properties.id) {
                                            console.debug(`[Warehouse Script] Binding popup for feature ${index}:`, feature.properties.id);
                                            layer.bindPopup(feature.properties.id);
                                        }
                                    }
                                }).addTo(map);
                                console.debug(`[Warehouse Script] Polygon added for feature ${index}`);

                                // Add the layer to the feature group
                                featureGroup.addLayer(geoJsonLayer);
                                console.debug(`[Warehouse Script] Feature ${index} added to feature group`);
                            } else {
                                console.warn(`[Warehouse Script] Feature ${index} is not a Polygon:`, feature);
                                frappe.msgprint(__('Invalid GeoJSON: One or more features are not Polygons.'));
                            }
                        });

                        // Fit the map view to the bounds of all polygons
                        console.debug('[Warehouse Script] Checking feature group bounds');
                        if (featureGroup.getBounds().isValid()) {
                            map.fitBounds(featureGroup.getBounds(), { padding: [50, 50] });
                            console.debug('[Warehouse Script] Map view set to bounds');
                        } else {
                            console.warn('[Warehouse Script] Invalid bounds for feature group');
                        }

                        // Calculate the centroid of all polygons
                        console.debug('[Warehouse Script] Calculating centroid');
                        let allCoordinates = [];
                        geojson.features.forEach(feature => {
                            if (feature.geometry && feature.geometry.type === 'Polygon') {
                                console.debug('[Warehouse Script] Collecting coordinates from feature:', feature.geometry.coordinates[0]);
                                allCoordinates.push(...feature.geometry.coordinates[0]);
                            }
                        });
                        console.debug('[Warehouse Script] All coordinates:', allCoordinates);

                        if (allCoordinates.length > 0) {
                            let sumLat = 0;
                            let sumLon = 0;
                            allCoordinates.forEach((coord, idx) => {
                                console.debug(`[Warehouse Script] Processing coordinate ${idx}:`, coord);
                                sumLon += coord[0];
                                sumLat += coord[1];
                            });

                            const avgLon = sumLon / allCoordinates.length;
                            const avgLat = sumLat / allCoordinates.length;
                            console.debug('[Warehouse Script] Calculated centroid:', { avgLat, avgLon });

                            // Set custom_location to GeoJSON Feature with point_type
                            const locationGeoJSON = {
                                type: "Feature",
                                geometry: {
                                    type: "Point",
                                    coordinates: [avgLon, avgLat]
                                },
                                properties: {
                                    point_type: "point"
                                }
                            };
                            let locationString = JSON.stringify(locationGeoJSON);
                            console.debug('[Warehouse Script] Setting custom_location to GeoJSON Feature:', locationString);

                            // Sanitize to prevent double-stringification
                            if (locationString.startsWith('"') && locationString.endsWith('"')) {
                                locationString = locationString.slice(1, -1);
                            }
                            console.debug('[Warehouse Script] Final custom_location value:', locationString);

                            // Set the value of the Geolocation field
                            frm.set_value('custom_location', locationString);
                            console.debug('[Warehouse Script] custom_location set');

                            // Log plain string format for reference
                            console.debug('[Warehouse Script] Plain string format (for reference):', `${avgLat},${avgLon}`);

                        } else {
                            console.warn('[Warehouse Script] No valid coordinates found for centroid');
                            frappe.msgprint(__('No valid coordinates found to calculate centroid.'));
                        }

                    } else {
                        console.warn('[Warehouse Script] Invalid GeoJSON structure:', geojson);
                        frappe.msgprint(__('Invalid GeoJSON: Must be a FeatureCollection with Polygon features.'));
                    }

                } catch (e) {
                    console.error('[Warehouse Script] Error processing GeoJSON:', e, 'Raw input:', rawGeoJSON);
                    frappe.msgprint(__('Invalid JSON format in `custom_raw_geojson`. Check the console for details.'));
                }
            } else {
                console.warn('[Warehouse Script] No GeoJSON data found in custom_raw_geojson');
            }
            console.debug('[Warehouse Script] Refresh function completed');
        }, 300);
    },

    // Trigger the refresh logic when the field's value changes
    custom_raw_geojson: function(frm) {
        console.debug('[Warehouse Script] custom_raw_geojson changed, triggering refresh');
        frm.refresh();
    }
});
