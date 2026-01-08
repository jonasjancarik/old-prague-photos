/**
 * Shared Correction UI Module
 * Handles the logic for crowdsourced position corrections (map, form, submission).
 */
const CorrectionUI = (() => {
    const MAPY_CZ_API_KEY = "JToxKFIPuYBZVmm3P8Kjujtg4wUEhzeP3TIBNcKxRV0";

    let state = {
        map: null,
        marker: null,
        currentFeature: null,
        proposedLat: null,
        proposedLon: null,
        onSuccess: null,
        onCancel: null,
        turnstileToken: "",
        turnstileBypass: false,
        turnstileWidgetId: null
    };

    function initMap(containerId) {
        if (state.map) return;
        const mapEl = document.getElementById(containerId);
        if (!mapEl) return;

        state.map = L.map(containerId, {
            zoomControl: true,
            scrollWheelZoom: true,
        }).setView([50.08, 14.42], 13);

        const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> přispěvatelé';
        const mapyAttr = '&copy; <a href="https://www.mapy.cz">Mapy.cz</a>';

        if (MAPY_CZ_API_KEY) {
            const mapyLayer = L.tileLayer(`https://api.mapy.cz/v1/maptiles/basic/256/{z}/{x}/{y}?apikey=${MAPY_CZ_API_KEY}`, {
                maxZoom: 19,
                attribution: `${mapyAttr}, ${osmAttr}`
            });
            mapyLayer.addTo(state.map);

            let fallbackActive = false;
            mapyLayer.on('tileerror', () => {
                if (fallbackActive) return;
                fallbackActive = true;
                state.map.removeLayer(mapyLayer);
                L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                    maxZoom: 19,
                    attribution: osmAttr,
                }).addTo(state.map);
            });
        } else {
            L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19,
                attribution: osmAttr,
            }).addTo(state.map);
        }

        state.map.on("click", (e) => {
            setProposed(e.latlng.lat, e.latlng.lng);
        });
    }

    function setProposed(lat, lon) {
        state.proposedLat = Number(lat.toFixed(6));
        state.proposedLon = Number(lon.toFixed(6));

        if (!state.marker) {
            state.marker = L.marker([lat, lon], { draggable: true }).addTo(state.map);
            state.marker.on("dragend", (e) => {
                const pos = e.target.getLatLng();
                state.proposedLat = Number(pos.lat.toFixed(6));
                state.proposedLon = Number(pos.lng.toFixed(6));
                updateSubmitButton();
            });
        } else {
            state.marker.setLatLng([lat, lon]);
        }
        updateSubmitButton();
    }

    function updateSubmitButton() {
        const btn = document.getElementById("correction-submit-btn");
        if (!btn) return;
        const hasPosition = state.proposedLat !== null;
        const hasToken = !!(state.turnstileToken || state.turnstileBypass);
        btn.disabled = !hasPosition || !hasToken;
    }

    function open(feature, options = {}) {
        state.currentFeature = feature;
        state.onSuccess = options.onSuccess || null;
        state.onCancel = options.onCancel || null;
        state.turnstileBypass = !!options.turnstileBypass;

        // Reset state
        state.proposedLat = null;
        state.proposedLon = null;
        if (state.marker) {
            state.map.removeLayer(state.marker);
            state.marker = null;
        }

        const [lon, lat] = feature.geometry.coordinates;
        state.map.setView([lat, lon], 17);
        state.map.invalidateSize();

        // Reset form fields
        const msgEl = document.getElementById("correction-message");
        const emailEl = document.getElementById("correction-email");
        if (msgEl) msgEl.value = "";
        if (emailEl) emailEl.value = "";

        updateSubmitButton();
        renderTurnstile(options.turnstileSiteKey);
    }

    function renderTurnstile(siteKey) {
        if (state.turnstileBypass || !siteKey || !window.turnstile) return;
        if (state.turnstileWidgetId !== null) return;

        state.turnstileWidgetId = window.turnstile.render("#correction-turnstile", {
            sitekey: siteKey,
            callback: (token) => {
                state.turnstileToken = token;
                updateSubmitButton();
            }
        });
    }

    async function submit() {
        if (!state.currentFeature || state.proposedLat === null) return;

        const msgEl = document.getElementById("correction-message");
        const emailEl = document.getElementById("correction-email");
        const statusEl = document.getElementById("correction-status");

        const payload = {
            xid: state.currentFeature.properties.id,
            lat: state.proposedLat,
            lon: state.proposedLon,
            verdict: "wrong",
            message: (msgEl?.value || "").trim() || "Nahlášena špatná poloha.",
            email: (emailEl?.value || "").trim() || null,
            token: state.turnstileToken || "",
        };

        try {
            const response = await fetch("/api/corrections", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.detail || "Odeslání selhalo");
            }

            if (statusEl) {
                statusEl.textContent = "Děkujeme! Oprava byla odeslána.";
                statusEl.className = "status-message success";
            }

            if (state.onSuccess) state.onSuccess();

            // Reset Turnstile
            state.turnstileToken = "";
            if (state.turnstileWidgetId !== null && window.turnstile) {
                window.turnstile.reset(state.turnstileWidgetId);
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = err.message || "Chyba při odesílání";
                statusEl.className = "status-message error";
            }
        }
    }

    function cancel() {
        if (state.onCancel) state.onCancel();
    }

    return {
        init: (containerId) => initMap(containerId),
        open,
        submit,
        cancel,
        setTurnstileBypass: (v) => { state.turnstileBypass = v; },
        setTurnstileToken: (t) => { state.turnstileToken = t; updateSubmitButton(); }
    };
})();
