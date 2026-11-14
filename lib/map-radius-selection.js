export function distanceInMeters(first, second) {
    const toRadians = degrees => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(second.lat - first.lat);
    const longitudeDelta = toRadians(second.lng - first.lng);
    const firstLatitude = toRadians(first.lat);
    const secondLatitude = toRadians(second.lat);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;

    return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function attachMapRadiusSelection(map, { radiusMeters = 5000, onSelect } = {}) {
    let center = null;
    let marker = null;
    let circle = null;
    let ripple = null;
    let animationFrame = null;
    let animationStartedAt = 0;
    const animationDuration = 1800;
    const handleMapClick = event => {
        center = event.latlng;
        if (marker) marker.setLatLng(center);
        else {
            marker = L.marker(center, {
                icon: L.divIcon({
                    className: 'map-radius-selection-icon',
                    html: '<svg width="32" height="42" viewBox="0 0 32 42" aria-hidden="true"><path d="M16 1C7.72 1 1 7.72 1 16c0 11.25 15 25 15 25s15-13.75 15-25C31 7.72 24.28 1 16 1Z" fill="#dc2626" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="#fff"/></svg>',
                    iconSize: [32, 42],
                    iconAnchor: [16, 41]
                }),
                interactive: false,
                keyboard: false
            }).addTo(map);
        }

        if (circle) circle.setLatLng(center);
        else {
            circle = L.circle(center, {
                radius: radiusMeters,
                color: '#2563eb',
                weight: 2,
                fillColor: '#3b82f6',
                fillOpacity: 0.08,
                interactive: false
            }).addTo(map);
        }

        if (ripple) ripple.setLatLng(center);
        else {
            ripple = L.circle(center, {
                radius: 40,
                color: '#2563eb',
                weight: 2,
                opacity: 0.75,
                fillOpacity: 0,
                interactive: false
            }).addTo(map);
            animationFrame = window.requestAnimationFrame(animateRipple);
        }

        if (onSelect) onSelect(center);
        animationStartedAt = 0;
        map.flyToBounds(circle.getBounds(), {
            padding: [32, 32],
            duration: 1.2,
            easeLinearity: 0.2
        });
    };

    const animateRipple = now => {
        if (!ripple) return;
        if (!animationStartedAt) animationStartedAt = now;
        const progress = ((now - animationStartedAt) % animationDuration) / animationDuration;
        const easedProgress = 1 - (1 - progress) ** 3;
        ripple.setRadius(Math.max(40, radiusMeters * easedProgress));
        ripple.setStyle({ opacity: 0.75 * (1 - easedProgress) });
        animationFrame = window.requestAnimationFrame(animateRipple);
    };

    map.on('click', handleMapClick);

    return {
        getCenter: () => center,
        destroy: () => {
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            map.off('click', handleMapClick);
            [marker, circle, ripple].forEach(layer => {
                if (layer && map.hasLayer(layer)) map.removeLayer(layer);
            });
        }
    };
}
