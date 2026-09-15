/* God's Eye Live Driver Tracking JS */
let map = null;
let currentPolygon = null;
let markersMap = new Map(); // driverId -> { marker, driverData }
let isMapInitialized = false;
let rawDriverData = []; // Cached drivers for fast status filtering
let rawZoneData = null;

const base_url = window.location.origin;

$(document).ready(function () {
    // Initial fetch for All Zones (zid: 0, vid: 0)
    fetchDriverLocations(0, 0, true);

    // Event Listeners for Filters
    $(document).on("change", '#zonedlist', function () {
        const zid = $(this).val();
        const vid = $("#zonevehicle").val() || 0;
        fetchDriverLocations(zid, vid, true);
    });

    $(document).on("change", '#zonevehicle', function () {
        const zid = $("#zonedlist").val() || 0;
        const vid = $(this).val();
        fetchDriverLocations(zid, vid, false);
    });

    $(document).on("change", '#driverstatus', function () {
        const selectedStatus = $(this).val();
        $(".stat-filter-card").removeClass("active");
        $(`.stat-filter-card[data-status="${selectedStatus}"]`).addClass("active");
        renderMapAndMarkers(rawZoneData, rawDriverData, false);
    });

    // Stat card click to filter
    $(document).on("click", ".stat-filter-card", function () {
        const status = $(this).attr("data-status");
        $(".stat-filter-card").removeClass("active");
        $(this).addClass("active");
        if ($("#driverstatus").val() !== status) {
            $("#driverstatus").val(status);
            renderMapAndMarkers(rawZoneData, rawDriverData, false);
        }
    });

    // Auto-refresh background polling every 3 seconds for instant live updates
    setInterval(function () {
        const zid = $("#zonedlist").val() || 0;
        const vid = $("#zonevehicle").val() || 0;
        fetchDriverLocations(zid, vid, false);
    }, 3000);
});

// Fetch location data from server
function fetchDriverLocations(zid, vid, centerMap = false) {
    $.ajax({
        url: base_url + '/zone/change_location',
        type: 'POST',
        dataType: 'JSON',
        data: { zid: zid, vid: vid },
        success: function (res) {
            if (res.status) {
                rawDriverData = res.dri || [];
                rawZoneData = res.data;
                updateDashboardStats(rawDriverData);
                renderMapAndMarkers(rawZoneData, rawDriverData, centerMap);
            }
        },
        error: function (err) {
            console.error("Error fetching driver locations:", err);
        }
    });
}

// Update Top Summary Stats Bar
function updateDashboardStats(drivers) {
    let total = drivers.length;
    let liveConnected = 0;
    let online = 0;
    let onRide = 0;
    let breakMode = 0;

    drivers.forEach(d => {
        if (d.is_device_live == 1) {
            liveConnected++;
        }
        if (d.break_mode == 1 || d.fstatus != 1) {
            breakMode++;
        } else if (d.rid_status == 1 || d.active_ride_count > 0) {
            onRide++;
        } else {
            online++;
        }
    });

    $("#stat-total-drivers").text(total);
    $("#stat-live-drivers").text(liveConnected);
    $("#stat-online-drivers").text(online);
    $("#stat-onride-drivers").text(onRide);
    $("#stat-break-drivers").text(breakMode);
}

// Render Google Map & Markers
async function renderMapAndMarkers(zoneData, drivers, resetBounds = false) {
    const { Map } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

    if (!isMapInitialized) {
        const defaultCenter = { lat: 20, lng: 0 }; // World center fallback
        if (zoneData && zoneData.lat_lon) {
            const firstPt = parseZoneCoordinates(zoneData.lat_lon)[0];
            if (firstPt) {
                defaultCenter.lat = firstPt.lat;
                defaultCenter.lng = firstPt.lng;
            }
        } else if (drivers.length > 0 && drivers[0].latitude) {
            defaultCenter.lat = Number(drivers[0].latitude);
            defaultCenter.lng = Number(drivers[0].longitude);
        }

        map = new Map(document.getElementById("map-canvas-edit"), {
            center: defaultCenter,
            zoom: zoneData ? 12 : 3,
            minZoom: 3,
            mapId: "4504f8b37365c3d0",
            restriction: {
                latLngBounds: { north: 85, south: -85, west: -180, east: 180 },
                strictBounds: false
            },
            mapTypeId: google.maps.MapTypeId.ROADMAP,
            styles: [
                { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] }
            ]
        });
        isMapInitialized = true;
    }

    // Update Zone Polygon
    if (currentPolygon) {
        currentPolygon.setMap(null);
        currentPolygon = null;
    }

    const isWorldZone = zoneData && zoneData.name && zoneData.name.toLowerCase().includes("world");

    if (zoneData && zoneData.lat_lon) {
        const coords = parseZoneCoordinates(zoneData.lat_lon);
        if (coords.length > 0) {
            currentPolygon = new google.maps.Polygon({
                paths: coords,
                strokeColor: "#4f46e5",
                strokeOpacity: 0.8,
                strokeWeight: 2,
                fillColor: "#6366f1",
                fillOpacity: 0.15,
                map: map
            });

            if (resetBounds) {
                if (isWorldZone) {
                    map.setCenter({ lat: 20, lng: 0 });
                    map.setZoom(3);
                } else {
                    const bounds = new google.maps.LatLngBounds();
                    coords.forEach(pt => bounds.extend(pt));
                    map.fitBounds(bounds);
                    if (map.getZoom() > 15) map.setZoom(14);
                }
            }
        }
    } else if (resetBounds) {
        // All Zones selected
        map.setCenter({ lat: 20, lng: 0 });
        map.setZoom(3);
    }

    // Apply Driver Status Filter
    const selectedStatus = $("#driverstatus").val() || "0";
    const filteredDrivers = drivers.filter(d => {
        if (selectedStatus === "live") {
            return d.is_device_live == 1;
        } else if (selectedStatus === "online") {
            return d.fstatus == 1 && d.break_mode != 1 && d.rid_status != 1 && d.active_ride_count == 0;
        } else if (selectedStatus === "onride") {
            return d.rid_status == 1 || d.active_ride_count > 0;
        } else if (selectedStatus === "break") {
            return d.break_mode == 1 || d.fstatus != 1;
        }
        return true; // "0" or all
    });

    // Sync Markers
    const currentDriverIds = new Set(filteredDrivers.map(d => d.id.toString()));

    // Remove obsolete markers
    markersMap.forEach((entry, id) => {
        if (!currentDriverIds.has(id)) {
            entry.marker.map = null;
            markersMap.delete(id);
        }
    });

    // Add or update markers
    filteredDrivers.forEach(driver => {
        if (!driver.latitude || !driver.longitude) return;

        const driverId = driver.id.toString();
        const pos = { lat: Number(driver.latitude), lng: Number(driver.longitude) };

        if (markersMap.has(driverId)) {
            // Update existing marker position & tooltip content dynamically
            const entry = markersMap.get(driverId);
            entry.marker.position = pos;
            entry.driverData = driver;

            const newContent = createCustomMarkerElement(driver);
            newContent.onclick = function(e) {
                if (e) e.stopPropagation();
                openDriverDetailModal(driver.id);
            };
            entry.marker.content = newContent;
        } else {
            // Create new AdvancedMarkerElement with clean vehicle image badge
            const markerContent = createCustomMarkerElement(driver);
            const marker = new AdvancedMarkerElement({
                position: pos,
                map: map,
                title: `${driver.first_name} ${driver.last_name}`,
                content: markerContent
            });

            marker.addListener("gmp-click", () => {
                openDriverDetailModal(driver.id);
            });

            markerContent.onclick = function(e) {
                if (e) e.stopPropagation();
                openDriverDetailModal(driver.id);
            };

            markersMap.set(driverId, { marker: marker, driverData: driver });
        }
    });
}

// Custom Marker Element Builder - Uses vehicle image inside clean status pill container with rich hover tooltip
function createCustomMarkerElement(driver) {
    const imgPath = driver.image ? `${base_url}/${driver.image}` : `${base_url}/uploads/vehicle/default.png`;

    let borderColor = "#10b981"; // Green (Online)
    let statusText = "ONLINE";
    let statusBg = "bg-success";

    if (driver.break_mode == 1 || driver.fstatus != 1) {
        borderColor = "#6b7280"; // Grey (Offline/Break)
        statusText = driver.break_mode == 1 ? "BREAK MODE" : "OFFLINE";
        statusBg = "bg-secondary";
    } else if (driver.rid_status == 1 || driver.active_ride_count > 0) {
        borderColor = "#f59e0b"; // Orange (On Ride)
        statusText = "ON ACTIVE RIDE";
        statusBg = "bg-warning text-dark";
    }

    const wrapper = document.createElement("div");
    wrapper.className = "vehicle-marker-badge position-relative";
    wrapper.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: #ffffff;
        padding: 4px 10px;
        border-radius: 24px;
        border: 2.5px solid ${borderColor};
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        cursor: pointer;
        transition: transform 0.2s ease, z-index 0.2s;
        position: relative;
    `;

    // Rich Hover Tooltip Card
    const tooltip = document.createElement("div");
    tooltip.className = "driver-hover-card shadow-lg";
    tooltip.style.cssText = `
        display: none;
        position: absolute;
        bottom: 120%;
        left: 50%;
        transform: translateX(-50%);
        width: 220px;
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.15);
        padding: 10px 12px;
        z-index: 9999;
        pointer-events: none;
        text-align: left;
        font-family: system-ui, -apple-system, sans-serif;
    `;

    let activeRideHtml = '';
    if (driver.rid_status == 1 && (driver.active_pic_address || driver.active_drop_address)) {
        const cleanPic = (driver.active_pic_address || 'Pickup Location').replace(/&!+/g, ', ').replace(/,\s*$/, '');
        const cleanDrop = (driver.active_drop_address || 'Drop Destination').replace(/&!+/g, ', ').replace(/,\s*$/, '');
        activeRideHtml = `
            <div class="mt-2 pt-2 border-top" style="border-color: #f1f5f9 !important;">
                <div class="d-flex align-items-center text-warning fw-bold mb-1" style="font-size: 11px;">
                    <i class="fa fa-spinner fa-spin me-1"></i> Running Ride Locations
                </div>
                <div class="text-truncate mb-1" style="font-size: 11px; color: #334155;" title="${cleanPic}">
                    <span class="text-success fw-bold">📍 Pick:</span> ${cleanPic}
                </div>
                <div class="text-truncate" style="font-size: 11px; color: #334155;" title="${cleanDrop}">
                    <span class="text-danger fw-bold">🏁 Drop:</span> ${cleanDrop}
                </div>
            </div>
        `;
    }

    const liveIndicator = driver.is_device_live == 1
        ? `<span class="badge bg-success text-white" style="font-size: 8.5px; padding: 2px 5px;"><i class="fa fa-bolt me-1"></i>LIVE</span>`
        : `<span class="badge bg-light text-muted" style="font-size: 8.5px; padding: 2px 5px; border: 1px solid #cbd5e1;"><i class="fa fa-clock-o me-1"></i>NO PING</span>`;

    const fullName = `${driver.first_name || ''} ${driver.last_name || ''}`.trim() || 'Driver';

    tooltip.innerHTML = `
        <div class="d-flex justify-content-between align-items-center mb-1 pb-1 border-bottom" style="border-color: #f1f5f9 !important;">
            <strong class="text-truncate me-2" style="font-size: 12.5px; color: #0f172a; max-width: 130px;" title="${fullName}">${fullName}</strong>
            <span class="badge ${statusBg}" style="font-size: 9px; padding: 3px 6px;">${statusText}</span>
        </div>
        <div class="d-flex justify-content-between align-items-center mb-1" style="font-size: 11px; color: #475569;">
            <span><i class="fa fa-phone me-1 text-primary"></i>${driver.primary_ccode || ''} ${driver.primary_phoneNo || ''}</span>
            ${liveIndicator}
        </div>
        <div style="font-size: 11px; color: #64748b;" class="text-truncate mb-1">
            <i class="fa fa-car me-1 text-secondary"></i>${driver.vehicle_name || 'Vehicle'} (${driver.vehicle_number || 'No Plate'})
        </div>
        <div style="font-size: 11px; color: #64748b;" class="text-truncate">
            <i class="fa fa-map-marker me-1 text-danger"></i>Zone: ${driver.zone_name || 'None'}
        </div>
        ${activeRideHtml}
    `;

    wrapper.appendChild(tooltip);
    const markerImg = document.createElement("img");
    markerImg.src = imgPath;
    markerImg.style.cssText = "height: 29px; width: auto; max-width: 52px; object-fit: contain; display: block;";
    markerImg.alt = driver.first_name || "Driver";
    markerImg.onerror = function () {
        this.src = `${base_url}/uploads/vehicle/1724496728586Group1000004645.png`;
    };
    wrapper.appendChild(markerImg);

    // Append Green Pulsing Dot ONLY for Live Connected Devices (real-time ping)
    if (driver.is_device_live == 1) {
        const liveDot = document.createElement("span");
        liveDot.className = "live-pulse-dot";
        liveDot.title = "Live Connected Device";
        wrapper.appendChild(liveDot);
    }

    wrapper.onmouseenter = function() {
        this.style.transform = "scale(1.18)";
        this.style.zIndex = "99999";
        tooltip.style.display = "block";
    };
    wrapper.onmouseleave = function() {
        this.style.transform = "scale(1.0)";
        this.style.zIndex = "1";
        tooltip.style.display = "none";
    };

    return wrapper;
}

// Parse lat_lon coordinates string (lat:lng,lat:lng)
function parseZoneCoordinates(latLonStr) {
    if (!latLonStr) return [];
    return latLonStr.split(',').map(pair => {
        const parts = pair.split(':');
        return { lat: Number(parts[0]), lng: Number(parts[1]) };
    }).filter(pt => !isNaN(pt.lat) && !isNaN(pt.lng));
}

// Open Rich Driver Details Modal
function openDriverDetailModal(driverId) {
    $.ajax({
        url: base_url + '/zone/driver_details',
        type: 'POST',
        dataType: 'JSON',
        data: { driver_id: driverId },
        success: function (res) {
            if (res.status && res.driver) {
                const d = res.driver;

                // Header & Avatar with Error Fallback
                $("#modal-driver-name").text(`${d.first_name || 'Driver'} ${d.last_name || ''}`);
                $("#modal-driver-phone").text(`${d.primary_ccode || ''} ${d.primary_phoneNo || ''}`);
                
                const avatarElem = document.getElementById("modal-driver-avatar");
                const avatarSrc = (d.profile_image && d.profile_image.trim() !== '') ? `${base_url}/${d.profile_image}` : `${base_url}/images/dashboard/default/profile.png`;
                avatarElem.src = avatarSrc;
                avatarElem.onerror = function () {
                    this.src = `${base_url}/images/dashboard/default/profile.png`;
                };

                // Single Accurate Status Badge
                const badgeElem = $("#modal-status-badge-single");
                if (res.active_ride) {
                    badgeElem.attr("class", "badge bg-warning text-dark").html('<i class="fa fa-car me-1"></i>ON ACTIVE RIDE');
                } else if (d.break_mode == 1) {
                    badgeElem.attr("class", "badge bg-secondary").html('<i class="fa fa-coffee me-1"></i>BREAK MODE');
                } else if (d.fstatus == 1) {
                    badgeElem.attr("class", "badge bg-success").html('<i class="fa fa-circle me-1"></i>ONLINE');
                } else {
                    badgeElem.attr("class", "badge bg-dark").html('<i class="fa fa-power-off me-1"></i>OFFLINE');
                }

                // Separate Live Device Ping Badge
                const liveDeviceBadge = $("#modal-live-device-badge");
                if (d.is_device_live == 1) {
                    liveDeviceBadge.attr("class", "badge bg-info text-dark").html('<i class="fa fa-bolt me-1"></i>LIVE DEVICE CONNECTED').show();
                } else {
                    liveDeviceBadge.attr("class", "badge bg-secondary text-white-50").html('<i class="fa fa-clock-o me-1"></i>NO RECENT PING').show();
                }

                // Vehicle Details & Image with Error Fallback
                $("#modal-vehicle-name").text(d.vehicle_name || 'Vehicle');
                $("#modal-vehicle-number").text(d.vehicle_number || 'N/A');
                $("#modal-vehicle-color").text(d.car_color || 'N/A');
                $("#modal-passenger-capacity").text(d.passenger_capacity ? `${d.passenger_capacity} Passengers` : 'N/A');
                
                const vehicleImgElem = document.getElementById("modal-vehicle-img");
                let vehicleSrc = `${base_url}/uploads/vehicle/1724496728586Group1000004645.png`;
                if (d.vehicle_image && d.vehicle_image.trim() !== '') {
                    vehicleSrc = `${base_url}/${d.vehicle_image}`;
                } else if (d.vehicle_type_image && d.vehicle_type_image.trim() !== '') {
                    vehicleSrc = `${base_url}/${d.vehicle_type_image}`;
                } else if (d.vehicle_map_img && d.vehicle_map_img.trim() !== '') {
                    vehicleSrc = `${base_url}/${d.vehicle_map_img}`;
                }

                vehicleImgElem.src = vehicleSrc;
                vehicleImgElem.onerror = function () {
                    if (d.vehicle_type_image && d.vehicle_type_image.trim() !== '') {
                        this.src = `${base_url}/${d.vehicle_type_image}`;
                    } else {
                        this.src = `${base_url}/uploads/vehicle/1724496728586Group1000004645.png`;
                    }
                };

                // Zones
                $("#modal-active-zones").text(d.zone_name || 'None');
                if (d.pending_zone_name && d.pending_zone_name.trim() !== '') {
                    $("#modal-pending-zones").text(d.pending_zone_name);
                    $("#modal-pending-zone-row").show();
                } else {
                    $("#modal-pending-zone-row").hide();
                }

                // Stats & Reviews
                $("#modal-completed-rides").text(d.tot_ride || '0');
                $("#modal-rating").html(`<i class="fa fa-star text-warning me-1"></i>${d.avg_rating || '5.0'}`);
                $("#modal-total-reviews").text(`${d.total_reviews || 0} reviews`);
                $("#modal-wallet-balance").text(`$${Number(d.wallet || 0).toFixed(2)}`);
                $("#modal-driver-email").text(d.email || 'N/A');

                // Active Ride Card
                if (res.active_ride) {
                    const ar = res.active_ride;
                    $("#modal-ride-status").text(ar.status || 'ACTIVE RIDE');
                    $("#modal-ride-customer").text(`${ar.customer_name || 'Customer'} (${ar.customer_phone || ''})`);
                    $("#modal-ride-pickup").text(ar.pic_address || 'Pickup Point');
                    $("#modal-ride-drop").text(ar.drop_address || 'Destination');
                    
                    if (ar.tracking_token) {
                        $("#modal-ride-track-btn").attr("href", `${base_url}/public/track/${ar.tracking_token}`).show();
                    } else {
                        $("#modal-ride-track-btn").hide();
                    }
                    $("#modal-active-ride-card").slideDown();
                } else {
                    $("#modal-active-ride-card").slideUp();
                }

                // Action Links
                $("#modal-call-btn").attr("href", `tel:${d.primary_ccode}${d.primary_phoneNo}`);
                $("#modal-profile-link").attr("href", `/driver/profile/${d.id}`);

                // Show Modal using Fail-Safe Trigger
                triggerDriverModal();
            }
        },
        error: function (err) {
            console.error("Error opening driver modal:", err);
        }
    });
}

// Fail-Safe Modal Trigger (Bootstrap 5, jQuery, or Vanilla JS Backdrop)
function triggerDriverModal() {
    const el = document.getElementById('driverDetailModal');
    if (!el) return;

    if (window.bootstrap && window.bootstrap.Modal) {
        try {
            let inst = window.bootstrap.Modal.getInstance(el);
            if (!inst) inst = new window.bootstrap.Modal(el);
            inst.show();
            return;
        } catch (e) {
            console.warn("Bootstrap 5 modal show error:", e);
        }
    }

    if (window.jQuery && $.fn && $.fn.modal) {
        try {
            $('#driverDetailModal').modal('show');
            return;
        } catch (e) {
            console.warn("jQuery modal show error:", e);
        }
    }

    // Vanilla JS Modal Fallback
    el.classList.add("show");
    el.style.display = "block";
    el.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
    el.removeAttribute("aria-hidden");
    el.setAttribute("aria-modal", "true");

    const closeBtns = el.querySelectorAll('[data-bs-dismiss="modal"], .btn-close, .btn-light, .btn-outline-secondary');
    closeBtns.forEach(btn => {
        btn.onclick = function() {
            el.classList.remove("show");
            el.style.display = "none";
        };
    });
}

// Socket.IO Integration for Real-Time Location Updates
if (typeof io !== 'undefined') {
    const socket = io();

    socket.on('Driver_location_Update', function (data) {
        if (data && data.id && data.latitude && data.longitude) {
            const driverId = data.id.toString();
            if (markersMap.has(driverId)) {
                const entry = markersMap.get(driverId);
                const newPos = { lat: Number(data.latitude), lng: Number(data.longitude) };
                entry.marker.setPosition(newPos);
            }
        }
        const zid = $("#zonedlist").val() || 0;
        const vid = $("#zonevehicle").val() || 0;
        fetchDriverLocations(zid, vid, false);
    });

    socket.on('Driver_location_On', function (data) {
        const zid = $("#zonedlist").val() || 0;
        const vid = $("#zonevehicle").val() || 0;
        fetchDriverLocations(zid, vid, false);
    });

    socket.on('Drive_location_Off', function (data) {
        if (data && data.id) {
            const driverId = data.id.toString();
            if (markersMap.has(driverId)) {
                markersMap.get(driverId).marker.setMap(null);
                markersMap.delete(driverId);
            }
        }
        const zid = $("#zonedlist").val() || 0;
        const vid = $("#zonevehicle").val() || 0;
        fetchDriverLocations(zid, vid, false);
    });

    // Ride Status Socket Event Triggers (Accept, Cancel, Start, Complete)
    ['accept_request', 'ride_status', 'vehiclerequest', 'home', 'ride_update'].forEach(function(evt) {
        socket.on(evt, function() {
            const zid = $("#zonedlist").val() || 0;
            const vid = $("#zonevehicle").val() || 0;
            fetchDriverLocations(zid, vid, false);
        });
    });
}